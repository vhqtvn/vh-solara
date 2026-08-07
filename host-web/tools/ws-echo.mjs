// Minimal WebSocket echo server (:5175) for the iframe-survival gate.
//
// Each accepted connection is assigned a monotonically incrementing connId,
// which is sent back as `{type:'welcome', connId}` and also echoed on every
// inbound frame. A cross-origin iframe that is merely repositioned (NOT
// destroyed) keeps its single socket open → connId stays stable. A reloaded
// iframe tears the socket down and opens a new one → connId increments. That
// increment is the independent, server-side reload signal the gate asserts on
// for the negative controls.
//
// Also serves GET /health → 200 so Playwright's `webServer.url` can poll for
// readiness (a raw WS server has no HTTP URL to poll).

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.WS_ECHO_PORT ?? 5175);
const HOST = process.env.WS_ECHO_HOST ?? "127.0.0.1";

let nextConnId = 1;

const server = http.createServer((req, res) => {
  if (req.url && req.url.split("?")[0] === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, totalConnections: nextConnId - 1 }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const connId = nextConnId++;
  ws.send(JSON.stringify({ type: "welcome", connId }));
  ws.on("message", (data) => {
    // Echo back verbatim so a pane can round-trip liveness pings if it wants.
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ws-echo listening on ws://${HOST}:${PORT} (health: /health)`);
});
