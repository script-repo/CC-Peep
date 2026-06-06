// Portal entry point: HTTP server (web-client + protocol) + WebSocket signaling.
//
// - GET /health           -> liveness probe
// - GET /                 -> web client UI (portal/web-client/)
// - GET /shared/protocol.js -> shared wire protocol (importable by the browser)
// - WS  /ws               -> presence + WebRTC signaling (see shared/protocol.js)

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SignalingHub } from "./signaling.js";

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// portal/server/src -> repo root
const ROOT = path.resolve(__dirname, "..", "..", "..");
const WEB_CLIENT_DIR = path.join(ROOT, "portal", "web-client");
const SHARED_DIR = path.join(ROOT, "shared");

// TLS is optional. Enable it by providing a cert + key via env vars, or by dropping
// cert.pem / key.pem into portal/certs/. Browsers require HTTPS (a secure context)
// before they expose microphone capture (getUserMedia).
const DEFAULT_CERT_DIR = path.join(ROOT, "portal", "certs");
function loadTls() {
  const certPath = process.env.CCPEEP_TLS_CERT || path.join(DEFAULT_CERT_DIR, "cert.pem");
  const keyPath = process.env.CCPEEP_TLS_KEY || path.join(DEFAULT_CERT_DIR, "key.pem");
  try {
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), certPath, keyPath };
    }
  } catch (err) {
    console.error(`[tls] failed to read cert/key: ${err.message}`);
  }
  return null;
}
const tls = loadTls();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// Resolve a request path against a base dir, refusing path traversal.
function safeJoin(baseDir, urlPath) {
  const resolved = path.normalize(path.join(baseDir, urlPath));
  if (!resolved.startsWith(baseDir)) return null;
  return resolved;
}

const hub = new SignalingHub();

function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: hub.sessions.size }));
    return;
  }

  // Serve the shared wire protocol so the browser imports the same source of truth.
  if (pathname.startsWith("/shared/")) {
    const filePath = safeJoin(SHARED_DIR, pathname.slice("/shared/".length));
    if (filePath) return sendFile(res, filePath);
  }

  // Serve the web client UI.
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = safeJoin(WEB_CLIENT_DIR, rel);
  if (filePath) return sendFile(res, filePath);

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}

const httpServer = tls
  ? https.createServer({ cert: tls.cert, key: tls.key }, requestHandler)
  : http.createServer(requestHandler);

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (socket, req) => {
  const send = (obj) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };
  const sendBinary = (buf) => {
    if (socket.readyState === socket.OPEN) socket.send(buf, { binary: true });
  };
  const { peerId, handleMessage, handleBinary, handleClose } = hub.connect(send, sendBinary);

  console.info(`[ws] connected peer=${peerId} from=${req.socket.remoteAddress}`);

  socket.on("message", (data, isBinary) => {
    if (isBinary) handleBinary(data);
    else handleMessage(data.toString());
  });
  socket.on("close", () => {
    handleClose();
    console.info(`[ws] disconnected peer=${peerId}`);
  });
  socket.on("error", (err) => console.error(`[ws] error peer=${peerId}:`, err.message));
});

const httpScheme = tls ? "https" : "http";
const wsScheme = tls ? "wss" : "ws";
httpServer.listen(PORT, HOST, () => {
  console.info(`audio-agents portal listening on ${httpScheme}://${HOST}:${PORT}` + (tls ? " (TLS)" : ""));
  if (tls) console.info(`  tls cert:   ${tls.certPath}`);
  console.info(`  web client: ${httpScheme}://${HOST}:${PORT}/`);
  console.info(`  health:     ${httpScheme}://${HOST}:${PORT}/health`);
  console.info(`  websocket:  ${wsScheme}://${HOST}:${PORT}/ws`);
  if (!tls) console.info("  (HTTP mode — browser mic needs HTTPS; see portal/README for TLS)");
});

function shutdown(reason) {
  console.info(`\n[portal] shutting down (${reason})`);
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
