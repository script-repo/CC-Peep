// Entry point: HTTP server + WebSocket signaling endpoint.
//
// - GET /health        -> liveness probe
// - WS  /ws            -> presence + WebRTC signaling (see ../../shared/protocol.js)

import http from "node:http";
import { WebSocketServer } from "ws";
import { SignalingHub } from "./signaling.js";

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const hub = new SignalingHub();

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: hub.sessions.size }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("audio-agents signaling server\nWebSocket endpoint: /ws\n");
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (socket, req) => {
  const send = (obj) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };
  const { peerId, handleMessage, handleClose } = hub.connect(send);

  console.info(`[ws] connected peer=${peerId} from=${req.socket.remoteAddress}`);

  socket.on("message", (data) => handleMessage(data.toString()));
  socket.on("close", () => {
    handleClose();
    console.info(`[ws] disconnected peer=${peerId}`);
  });
  socket.on("error", (err) => console.error(`[ws] error peer=${peerId}:`, err.message));
});

httpServer.listen(PORT, HOST, () => {
  console.info(`audio-agents signaling server listening on http://${HOST}:${PORT}`);
  console.info(`  health:    http://${HOST}:${PORT}/health`);
  console.info(`  websocket: ws://${HOST}:${PORT}/ws`);
});

function shutdown(reason) {
  console.info(`\n[server] shutting down (${reason})`);
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
