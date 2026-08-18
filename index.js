// GitHub Release -> Discord Forum Bridge
// Receives GitHub release webhooks and turns them into a new forum post
// in the Discord channel (via Discord webhook + thread_name).

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

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

    // Only react to "release" events, and only when a release was actually
    // published (not e.g. just saved as a draft).
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

    const discordBody = {
      thread_name: `${release.tag_name} — ${release.name || release.tag_name}`,
      content:
        `**New release for ${repo.name}**\n` +
        `${release.html_url}\n\n` +
        `${truncate(release.body, 1500)}`,
    };

    const discordRes = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordBody),
    });

    if (!discordRes.ok) {
      const errText = await discordRes.text();
      return new Response(`Discord error: ${errText}`, { status: 502 });
    }

    return new Response("OK", { status: 200 });
  },
};

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
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