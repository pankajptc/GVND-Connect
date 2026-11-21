const console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = path.resolve(process.cwd(), ".mesh-media-cache");
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch {}

const liveMediaMap = new Map<string, string>();
const livePeers = new Map<string, any>();
const liveMsgs = new Map<string, any>();

function safeKeyFile(mediaKey: string): string {
  const clean = String(mediaKey || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return path.join(CACHE_DIR, `${clean}.txt`);
}

function getCachedMedia(mediaKey: string): string {
  const mem = liveMediaMap.get(mediaKey);
  if (mem) return mem;
  try {
    const file = safeKeyFile(mediaKey);
    if (fs.existsSync(file)) {
      const diskData = fs.readFileSync(file, "utf8");
      if (diskData) {
        liveMediaMap.set(mediaKey, diskData);
        return diskData;
      }
    }
  } catch {}
  return "";
}

function setCachedMedia(mediaKey: string, dataUrl: string): void {
  liveMediaMap.set(mediaKey, dataUrl);
  try {
    fs.writeFileSync(safeKeyFile(mediaKey), dataUrl, "utf8");
  } catch {}
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleMesh(request: Request): Promise<Response> {
  const ts = new Date().toLocaleTimeString();
  if (request.method === "POST") {
    try {
      const cloned = request.clone();
      const body = await cloned.json();
      if (body && body.action === "media" && body.mediaKey && body.dataUrl) {
        setCachedMedia(body.mediaKey, body.dataUrl);
        
        return json({ ok: true });
      }
      if (body && body.action === "hasMedia" && body.mediaKey) {
        const exists = Boolean(getCachedMedia(body.mediaKey));
        
        return json({ ok: true, exists });
      }
      if (body && body.action === "getMedia" && body.mediaKey) {
        const hit = getCachedMedia(body.mediaKey);
        return json({ ok: true, dataUrl: hit });
      }
      if (body && body.action === "ack" && body.id) {
        const existing = liveMsgs.get(body.id);
        if (existing) {
          const rank = (s: string) => (s === "read" ? 3 : s === "delivered" ? 2 : s === "sent" ? 1 : 0);
          const nextSt = body.status || "delivered";
          if (rank(nextSt) >= rank(existing.status || "")) {
            liveMsgs.set(body.id, { ...existing, status: nextSt });
            
          }
        }
        return json({ ok: true });
      }
      if (body && body.action === "sync") {
        const now = Date.now();
        if (body.peer?.globalId) {
          livePeers.set(body.peer.globalId.toLowerCase(), { ...body.peer, lastSeen: now });
        }
        if (Array.isArray(body.outbox)) {
          for (const m of body.outbox) {
            if (m?.id) {
              const prev = liveMsgs.get(m.id);
              const upgradedStatus =
                prev?.status === "read"
                  ? "read"
                  : prev?.status === "delivered"
                  ? "delivered"
                  : m.status === "queued"
                  ? "sent"
                  : m.status || "sent";
              if (!prev) {
                
              }
              liveMsgs.set(m.id, { ...m, status: upgradedStatus });
            }
          }
        }
        for (const [k, v] of livePeers.entries()) {
          if (now - (v.lastSeen || 0) > 60000) livePeers.delete(k);
        }
        return json({
          ok: true,
          peers: Array.from(livePeers.values()),
          messages: Array.from(liveMsgs.values()).slice(-80),
        });
      }
    } catch (err: any) {
      
    }
  }
  if (request.method === "GET") {
    return json({
      app: "GVND Connect",
      mode: "gundb-crdt + sha256-indexeddb-disk-swarm",
      items: [],
    });
  }
  if (request.method === "POST") {
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}
