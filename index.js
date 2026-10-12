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
// Nothing the crawler needs may depend on a fresh KV read. KV is
// eventually consistent: a write is usually visible at once in the
// location that made it, but can take up to 60 seconds elsewhere, and
// negative lookups are cached too. Discord unfurls within milliseconds
// of the message being posted, from some other location, and caches the
// result -- including a failure. A single 404 there costs that release
// its preview permanently. So the preview page carries its own data in
// the URL, and the image route re-renders instead of answering 404.
//
// Routes:
//   POST /                  GitHub release webhook receiver
//   GET  /p/:payload        Open Graph preview page, self contained: the
//                           tags come out of the URL, not out of KV
//   GET  /r/:slug           Same page for links posted before /p existed,
//                           read from KV
//   GET  /r/:slug/image.png The rendered preview image. KV is only a
//                           cache here; a miss renders the image again

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.startsWith("/p/")) {
      return handleStatelessPreview(url, env);
    }

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

  const meta = {
    title: release.name || release.tag_name,
    description: truncate(stripMarkdown(release.body), 300),
    htmlUrl: release.html_url,
    imageUrl,
    slug,
    version: release.tag_name,
  };

  // Kept so links posted by earlier versions of this Worker still resolve.
  // Nothing posted from here on reads it.
  await env.PREVIEWS.put(`previews/${slug}.json`, JSON.stringify(meta));

  // The tags travel inside the link, so the crawler gets a complete page on
  // its first and only try, whatever KV happens to be doing at that moment.
  const { imageUrl: _unused, ...linkMeta } = meta;
  const previewUrl = `${origin}/p/${encodePayload(linkMeta)}`;

  // Discord only renders markdown (bold, lists, links, ...) in the
  // message content itself -- an unfurled embed's description is
  // always plain text pulled from og:description. So the changelog
  // has to be part of the posted message, not just the meta JSON.
  //
  // Discord refuses a message over 2000 characters outright, and the
  // header line alone is several hundred of them (the preview link
  // carries its data). So the changelog is split into as many messages
  // as it needs: the first opens the forum thread, the rest follow in it.
  const changelog = release.body ? release.body.trim() : "";
  const linkLabel = release.name || release.tag_name;
  const header = `**New release for ${repo.name}** [${linkLabel}](${previewUrl})`;
  const [first, ...rest] = splitMessage(
    [header, changelog].filter(Boolean).join("\n\n"),
    DISCORD_MESSAGE_LIMIT
  );

  // `wait=true` makes Discord answer with the message it created; for a
  // forum post its channel_id is the new thread, which is where the
  // follow-ups go.
  const opened = await postToDiscord(env, "?wait=true", {
    thread_name: `${release.tag_name} — ${release.name || release.tag_name}`,
    content: first,
  });
  if (!opened) return;

  const threadId = (await opened.json()).channel_id;
  for (const content of rest) {
    // In order, one at a time: parallel posts can arrive shuffled.
    const sent = await postToDiscord(env, `?thread_id=${threadId}`, { content });
    if (!sent) return;
  }
}

const DISCORD_MESSAGE_LIMIT = 2000;

async function postToDiscord(env, query, body) {
  const res = await fetch(env.DISCORD_WEBHOOK_URL + query, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("Discord error:", res.status, await res.text());
    return null;
  }
  return res;
}

// Cuts at the last line break that fits, so a list item or a heading is
// never torn in half. A single line longer than the limit, which only a
// pasted wall of text has, is cut where it must be.
function splitMessage(text, limit) {
  const parts = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) parts.push(remaining);
  return parts;
}

// ---------------------------------------------------------------
// Preview page + image serving
// ---------------------------------------------------------------

async function handleStatelessPreview(url, env) {
  const encoded = url.pathname.split("/").filter(Boolean)[1]; // ["p", payload]
  if (!encoded) return new Response("Not found", { status: 404 });

  let meta;
  try {
    meta = decodePayload(encoded);
  } catch (err) {
    return new Response("Not found", { status: 404 });
  }

  return previewPage(meta, url, env);
}

async function handlePreviewRequest(url, env) {
  const parts = url.pathname.split("/").filter(Boolean); // ["r", slug, "image.png"?]
  const slug = parts[1];
  if (!slug) return new Response("Not found", { status: 404 });

  if (parts[2] === "image.png") {
    return serveImage(slug, url.searchParams.get("v"), env);
  }

  const metaText = await env.PREVIEWS.get(`previews/${slug}.json`);
  if (!metaText) return new Response("Not found", { status: 404 });

  return previewPage(JSON.parse(metaText), url, env);
}

async function serveImage(slug, version, env) {
  const key = `previews/${slug}.png`;
  let bytes = await env.PREVIEWS.get(key, "arrayBuffer");

  // A miss here is almost always the write from minutes ago that has not
  // reached this location yet, not a release we never rendered. Rendering
  // again costs one browser call; answering 404 costs the preview.
  if (!bytes && version && slugMatchesVersion(slug, version)) {
    try {
      bytes = await takeScreenshot(env, await renderTemplateHtml(env, version));
      await env.PREVIEWS.put(key, bytes);
    } catch (err) {
      console.error("On-demand preview render failed:", err);
    }
  }

  if (!bytes) {
    return Response.redirect(
      bridgeAssetUrl(
        env,
        env.BRIDGE_FALLBACK_IMAGE_PATH || "public/assets/social-preview.png"
      ),
      302
    );
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      // Each slug is unique per release, so the image never changes.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// buildSlug puts the sanitised tag in the middle of the slug. A `?v=` that
// does not appear there did not come from a link this Worker posted.
function slugMatchesVersion(slug, version) {
  const sanitised = String(version).toLowerCase().replace(/[^a-z0-9.\-]/g, "-");
  return sanitised.length > 0 && slug.includes(`-${sanitised}-`);
}

function previewPage(meta, url, env) {
  // Old KV entries store the finished image URL; new links carry the slug and
  // the version so the image route can rebuild the picture if it has to.
  const imageUrl = meta.slug
    ? `${url.origin}/r/${meta.slug}/image.png?v=${encodeURIComponent(meta.version)}`
    : meta.imageUrl;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(meta.title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(meta.title)}">
<meta property="og:description" content="${escapeHtml(meta.description)}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="${Number(env.SCREENSHOT_WIDTH) || 1200}">
<meta property="og:image:height" content="${Number(env.SCREENSHOT_HEIGHT) || 630}">
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

// URL safe base64 of the JSON, so the whole preview fits in the link. The
// posted link is masked behind the release name in Discord, so its length
// costs nothing.
function encodePayload(meta) {
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodePayload(encoded) {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function url_origin(href) {
  return new URL(href).origin;
}

function buildSlug(repo, release) {
  return `${repo.full_name.replace(/\//g, "--")}-${release.tag_name}-${release.id}`
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
