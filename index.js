// GitHub Release -> Discord Forum Bridge
// Nimmt GitHub-Release-Webhooks entgegen und erstellt daraus einen neuen
// Forum-Post im Discord-Kanal (via Discord Webhook + thread_name).

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();

    // Optional, aber empfohlen: GitHub signiert den Payload mit dem Secret,
    // das beim Anlegen des Repo-Webhooks eingetragen wurde.
    if (env.GITHUB_SECRET) {
      const signature = request.headers.get("x-hub-signature-256");
      const valid = await verifySignature(env.GITHUB_SECRET, signature, body);
      if (!valid) {
        return new Response("Invalid signature", { status: 401 });
      }
    }

    // Nur auf "release" Events reagieren, und nur wenn ein Release
    // veröffentlicht (nicht z.B. nur als Draft gespeichert) wurde.
    const event = request.headers.get("x-github-event");
    if (event === "ping") {
      // GitHub schickt beim Anlegen des Webhooks einen Test-Ping.
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
        `**Neues Release für ${repo.name}**\n` +
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
