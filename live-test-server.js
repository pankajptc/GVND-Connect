import http from 'http';
import dgram from 'dgram';
import { WebSocketServer } from 'ws';

const HTTP_PORT = 18080;
const UDP_PORT = 41234;

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', protocol: 'HTTP', udpPort: UDP_PORT }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('GVND Connect HTTP + UDP Bridge Active');
});

const wss = new WebSocketServer({ server: httpServer });
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('message', (msg, rinfo) => {
  const payload = JSON.stringify({
    type: 'UDP_PEER_FOUND',
    ip: rinfo.address,
    port: rinfo.port,
    data: msg.toString(),
  });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(payload);
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const buf = Buffer.from(data.toString());
    udpSocket.send(buf, 0, buf.length, UDP_PORT, '255.255.255.255');
  });
});

udpSocket.bind(UDP_PORT, '0.0.0.0', () => {
  udpSocket.setBroadcast(true);
  console.log(`[UDP] Discovery active on 0.0.0.0:${UDP_PORT}`);
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Bridge active on http://0.0.0.0:${HTTP_PORT}`);
});
