import http from "node:http";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HTTP_PORT = 18081;
const UDP_PORT = 18082;
const DIST_DIR = path.resolve("dist");

const rooms = new Map(); // room -> Map(peerId -> { id, name, ip, lastSeen })
const signals = [];      // { id, room, from, to, kind, payload, ts }
let nextSignalId = 1;
const meshMail = new Map();

function getLocalIPs() {
  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function touchPeer(room, id, name, ip = "127.0.0.1") {
  if (!room || !id) return;
  if (!rooms.has(room)) rooms.set(room, new Map());
  rooms.get(room).set(id, { id, name: name || id, ip, lastSeen: Date.now() });
}

function getRoster(room) {
  const map = rooms.get(room);
  if (!map) return [];
  const now = Date.now();
  const list = [];
  for (const [id, p] of map.entries()) {
    if (now - p.lastSeen > 30000) map.delete(id);
    else list.push({ id: p.id, name: p.name });
  }
  return list;
}

// 1. UDP Port 18082: LAN Auto-Discovery Beacon
const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
udp.on("message", (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    if (data.type === "GVND_BEACON" && data.id) {
      touchPeer(data.room || "hub-mrt", data.id, data.name || "GVND Node", rinfo.address);
    }
  } catch {}
});

udp.bind(UDP_PORT, "0.0.0.0", () => {
  try { udp.setBroadcast(true); } catch {}
  console.log(`📡 UDP Auto-Discovery active on port ${UDP_PORT}`);
});

const stationId = `station_${os.hostname()}_${process.pid}`;
setInterval(() => {
  const payload = Buffer.from(JSON.stringify({
    type: "GVND_BEACON",
    room: "hub-mrt",
    id: stationId,
    name: "GVND Station",
  }));
  try { udp.send(payload, 0, payload.length, UDP_PORT, "255.255.255.255"); } catch {}
}, 2500);

// 2. HTTP Port 18081: UI + Exact /api/rtc & /api/mesh Schema
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      app: "GVND Connect",
      httpPort: HTTP_PORT,
      udpPort: UDP_PORT,
      ips: getLocalIPs(),
      peers: getRoster("hub-mrt"),
    });
  }

  if (url.pathname === "/api/rtc") {
    if (req.method === "POST") {
      const body = await readBody(req);
      if (body.op === "leave" && body.room && body.peer) {
        rooms.get(body.room)?.delete(body.peer);
        return sendJson(res, 200, { ok: true });
      }
      if (body.op === "signal") {
        const sig = {
          id: nextSignalId++,
          room: body.room || "hub-mrt",
          from: body.from,
          to: body.to,
          kind: body.kind,
          payload: body.payload,
          ts: Date.now(),
        };
        signals.push(sig);
        if (signals.length > 500) signals.shift();
        return sendJson(res, 200, { ok: true, id: sig.id });
      }
      return sendJson(res, 200, { ok: true });
    }

    const room = url.searchParams.get("room") || "hub-mrt";
    const peer = url.searchParams.get("peer") || "";
    const name = url.searchParams.get("name") || "";
    const since = Number(url.searchParams.get("since") || 0);

    if (peer) touchPeer(room, peer, name, req.socket.remoteAddress || "127.0.0.1");

    const inbox = signals.filter(
      (s) => s.room === room && s.id > since && (!peer || s.to === peer)
    );
    const cursor = inbox.length ? inbox[inbox.length - 1].id : since;

    return sendJson(res, 200, {
      peers: getRoster(room),
      signals: inbox,
      cursor,
      lastId: cursor,
    });
  }

  if (url.pathname === "/api/mesh") {
    const uid = url.searchParams.get("uid") || "global";
    if (req.method === "POST") {
      const body = await readBody(req);
      const target = body.to || uid;
      const list = meshMail.get(target) || [];
      list.push({ ts: Date.now(), ...body });
      meshMail.set(target, list.slice(-200));
      return sendJson(res, 200, { ok: true });
    }
    const items = meshMail.get(uid) || [];
    return sendJson(res, 200, {
      app: "GVND Connect",
      mode: "gundb-crdt + sha256-indexeddb-swarm",
      items,
      messages: items,
    });
  }

  let filePath = path.join(DIST_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, "index.html");
  }
  res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`🚀 GVND Connect Dual-Port Server live on http://0.0.0.0:${HTTP_PORT}`);
  console.log(`🌐 LAN IPs:`, getLocalIPs().map((ip) => `http://${ip}:${HTTP_PORT}`).join(", ") || "localhost only");
});
