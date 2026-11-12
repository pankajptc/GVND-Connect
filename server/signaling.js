import http from "node:http";
import { WebSocketServer } from "ws";
import Gun from "gun";

const PORT = Number(process.env.PORT || 18081);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ app: "GVND Connect", status: "ok", mode: "hybrid-mesh" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("GVND Connect Hybrid Relay Active");
});

// 1. GunDB Control-Plane Relay (Only lightweight metadata, radisk disabled on relay to prevent disk bloat)
const gun = Gun({
  web: server,
  radisk: false,
  localStorage: false,
});

// 2. WebRTC & Swarm Chunk Signaling Bridge
const wss = new WebSocketServer({ server, path: "/ws" });
const peers = new Map();

wss.on("connection", (ws) => {
  let peerId = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === "register" && msg.peerId) {
        peerId = msg.peerId;
        peers.set(peerId, ws);
        broadcast({ type: "peer-joined", peerId }, peerId);
        return;
      }

      // Direct target routing (WebRTC offer/answer/ice ya Swarm chunk request)
      if (msg.target && peers.has(msg.target)) {
        const targetWs = peers.get(msg.target);
        if (targetWs.readyState === 1) {
          targetWs.send(JSON.stringify(msg));
        }
        return;
      }

      // Room / Swarm broadcast
      broadcast(msg, peerId);
    } catch {
      // Ignore malformed frames
    }
  });

  ws.on("close", () => {
    if (peerId) {
      peers.delete(peerId);
      broadcast({ type: "peer-left", peerId }, peerId);
    }
  });
});

function broadcast(payload, excludeId) {
  const data = JSON.stringify(payload);
  for (const [id, client] of peers.entries()) {
    if (id !== excludeId && client.readyState === 1) {
      client.send(data);
    }
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[GVND Connect] Hybrid Control + Signaling Server running on port ${PORT}`);
});
