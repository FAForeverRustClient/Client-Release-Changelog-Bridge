// GitHub Release -> Discord Forum Bridge
// ----------------------------------------------------------------
// When a GitHub release is published, this Worker renders a branded,
// version-stamped preview image and posts a PLAIN LINK to Discord
// (not a bot-built embed). Discord unfurls that link itself, the
// normal way, using Open Graph tags served by this same Worker --
// exactly like sharing any other URL.
//
// Why not just share the GitHub release link directly? GitHub
// generates its own fixed preview for release pages and does not
// allow overriding it with a custom image. So instead we post a link
// to a small preview page hosted by this Worker, which carries our
// own og:image/title/description and redirects human visitors to the
// real GitHub release page via JavaScript (not a meta-refresh, which
// some crawlers -- including Discord's -- treat as an actual redirect
// and follow, unfurling GitHub's own preview instead of ours).
// Crawlers don't execute JS, so they read our static tags and stop
// there; only real browsers run the redirect script.
//
// Routes:
//   POST /                  GitHub release webhook receiver
//   GET  /r/:slug           Open Graph preview page (redirects humans
//                           to the real GitHub release)
//   GET  /r/:slug/image.png The rendered preview image (served from KV)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.startsWith("/r/")) {
      return handlePreviewRequest(url, env);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    return handleGitHubWebhook(request, env, ctx);
  },
};

// ---------------------------------------------------------------
// GitHub webhook handling
// ---------------------------------------------------------------

async function handleGitHubWebhook(request, env, ctx) {
  const body = await request.text();

  // Optional but recommended: GitHub signs the payload with the secret
  // that was entered when the repo webhook was created.
  if (env.GITHUB_SECRET) {
    const signature = request.headers.get("x-hub-signature-256");
    const valid = await verifySignature(env.GITHUB_SECRET, signature, body);
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }
  }

  const event = request.headers.get("x-github-event");
  if (event === "ping") {
    // GitHub sends a test ping when the webhook is created.
    return new Response("pong", { status: 200 });
  }
  if (event !== "release") {
    return new Response("Ignored (not a release event)", { status: 200 });
  }

  const payload = JSON.parse(body);
  if (payload.action !== "published") {
    return new Response("Ignored (not published)", { status: 200 });
  }

  const release = payload.release;
  const repo = payload.repository;
  const origin = url_origin(request.url);

  // Respond to GitHub right away; rendering the screenshot and posting
  // to Discord can take a couple of seconds and shouldn't hold up the
  // webhook delivery.
  ctx.waitUntil(publishRelease({ release, repo, origin, env }));

  return new Response("Accepted", { status: 202 });
}

async function publishRelease({ release, repo, origin, env }) {
  const slug = buildSlug(repo, release);

  let imageUrl;
  try {
    const html = await renderTemplateHtml(env, release.tag_name);
    const png = await takeScreenshot(env, html);
    await env.PREVIEWS.put(`previews/${slug}.png`, png);
    imageUrl = `${origin}/r/${slug}/image.png`;
  } catch (err) {
    // Fall back to the static, version-less preview image so the
    // release announcement still goes out with a branded image.
    console.error("Dynamic preview render failed, using static fallback:", err);
    imageUrl = bridgeAssetUrl(
      env,
      env.BRIDGE_FALLBACK_IMAGE_PATH || "public/assets/social-preview.png"
    );
  }

  await env.PREVIEWS.put(
    `previews/${slug}.json`,
    JSON.stringify({
      title: release.name || release.tag_name,
      description: truncate(stripMarkdown(release.body), 300),
      htmlUrl: release.html_url,
      imageUrl,
    })
  );

  const previewUrl = `${origin}/r/${slug}`;

  // Discord only renders markdown (bold, lists, links, ...) in the
  // message content itself -- an unfurled embed's description is
  // always plain text pulled from og:description. So the changelog
  // has to be part of the posted message, not just the meta JSON.
  const changelog = release.body ? truncate(release.body.trim(), 1500) : "";
  const linkLabel = release.name || release.tag_name;
  const content = [
    `**New release for ${repo.name}** [${linkLabel}](${previewUrl})`,
    changelog,
  ]
    .filter(Boolean)
    .join("\n\n");

  const discordBody = {
    thread_name: `${release.tag_name} — ${release.name || release.tag_name}`,
    content,
  };

  const discordRes = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(discordBody),
  });

  if (!discordRes.ok) {
    console.error("Discord error:", await discordRes.text());
  }
}

// ---------------------------------------------------------------
// Preview page + image serving
// ---------------------------------------------------------------

async function handlePreviewRequest(url, env) {
  const parts = url.pathname.split("/").filter(Boolean); // ["r", slug, "image.png"?]
  const slug = parts[1];
  if (!slug) return new Response("Not found", { status: 404 });

  if (parts[2] === "image.png") {
    const bytes = await env.PREVIEWS.get(`previews/${slug}.png`, "arrayBuffer");
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/png",
        // Each slug is unique per release, so the image never changes.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  const metaText = await env.PREVIEWS.get(`previews/${slug}.json`);
  if (!metaText) return new Response("Not found", { status: 404 });
  const meta = JSON.parse(metaText);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(meta.title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(meta.title)}">
<meta property="og:description" content="${escapeHtml(meta.description)}">
<meta property="og:image" content="${meta.imageUrl}">
<meta property="og:url" content="${url.toString()}">
<meta name="twitter:card" content="summary_large_image">
</head>
<body>
<p>Redirecting to <a href="${meta.htmlUrl}">${escapeHtml(meta.htmlUrl)}</a>…</p>
<script>window.location.replace(${JSON.stringify(meta.htmlUrl)});</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------
// Rendering (bridge repo template -> screenshot)
// ---------------------------------------------------------------

function bridgeAssetUrl(env, path) {
  const repo = env.BRIDGE_ASSET_REPO || "FAForeverRustClient/Client-Release-Changelog-Bridge";
  const branch = env.BRIDGE_ASSET_BRANCH || "main";
  return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

async function renderTemplateHtml(env, version) {
  const templatePath = env.BRIDGE_TEMPLATE_PATH || "public/assets/social-preview.html";
  const templateUrl = bridgeAssetUrl(env, templatePath);
  const templateDirUrl = templateUrl.replace(/[^/]+$/, "");

  const res = await fetch(templateUrl);
  if (!res.ok) throw new Error(`Template fetch failed: ${res.status}`);
  let html = await res.text();

  // Relative asset paths (fonts, images, css) in the template need to
  // resolve against the bridge repo, since we're rendering raw HTML
  // with no page origin of its own.
  const baseTag = `<base href="${templateDirUrl}">`;
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`)
    : `${baseTag}${html}`;

  const placeholder = env.VERSION_PLACEHOLDER || "{{VERSION}}";
  return html.split(placeholder).join(version);
}

async function takeScreenshot(env, html) {
  const width = Number(env.SCREENSHOT_WIDTH) || 1200;
  const height = Number(env.SCREENSHOT_HEIGHT) || 630;

  const res = await env.BROWSER.quickAction("screenshot", {
    html,
    viewport: { width, height },
    screenshotOptions: { type: "png" },
  });
  if (!res.ok) throw new Error(`Screenshot failed: ${res.status}`);
  return await res.arrayBuffer();
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function url_origin(href) {
  return new URL(href).origin;
}

function buildSlug(repo, release) {
  return `${repo.full_name.replace(/\//g, "--")}-${release.tag_name}`
    .toLowerCase()
    .replace(/[^a-z0-9.\-]/g, "-");
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function stripMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/[#*_`>]/g, "")
    .replace(/\r?\n+/g, " ")
    .trim();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

async function verifySignature(secret, signatureHeader, body) {
  if (!signatureHeader) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected =
    "sha256=" +
    [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, signatureHeader);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
