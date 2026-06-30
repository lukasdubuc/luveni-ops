// ─────────────────────────────────────────────────────────────
//  Luveni Ops — Astra realtime voice token server
//  Mints short-lived LiveKit access tokens so the browser can join a
//  low-latency WebRTC room where Astra's voice pipeline (STT → LLM with
//  Astra's tools → TTS) runs as a server participant. Credentials never
//  reach the client. Plain Node http — no framework dependency.
//
//  The agent worker that joins the room is configured from Astra's
//  profile in agents.ts (same system prompt + tools as the text fleet),
//  so voice and text share one brain. See README "Astra voice".
// ─────────────────────────────────────────────────────────────

import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { AGENT_BY_ID } from "../agents.js";

const PORT = Number(process.env.ASTRA_TOKEN_PORT ?? 8787);
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "";
const API_KEY = process.env.LIVEKIT_API_KEY ?? "";
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? "";

// Minimal JWT (HS256) — LiveKit access tokens are standard JWTs.
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintLiveKitToken(identity: string, room: string, ttlSeconds = 600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: API_KEY,
    sub: identity,
    nbf: now,
    exp: now + ttlSeconds,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true },
    metadata: JSON.stringify({ agent: "astra" }),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = base64url(createHmac("sha256", API_SECRET).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, astra: !!AGENT_BY_ID.astra, livekitConfigured: !!(API_KEY && API_SECRET) }));
    return;
  }

  if (u.pathname === "/astra/token") {
    if (!API_KEY || !API_SECRET) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "LiveKit not configured (LIVEKIT_API_KEY/SECRET)" }));
      return;
    }
    const identity = u.searchParams.get("identity") || `owner-${Date.now()}`;
    const room = u.searchParams.get("room") || "astra";
    const token = mintLiveKitToken(identity, room);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token, url: LIVEKIT_URL, room, identity }));
    return;
  }

  res.writeHead(404); res.end("not found");
}).listen(PORT, () => {
  console.log(`Astra token server on :${PORT}  (GET /astra/token?room=astra)`);
});
