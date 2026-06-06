// Windows VM audio agent.
//
// Connects to the portal's signaling server over WebSocket, announces itself as a
// `vm-agent`, tracks presence, and handles WebRTC signaling passthrough. Audio
// capture/playback (WASAPI via NAudio) plugs into the hooks marked TODO below.
//
// Configuration (first match wins):
//   1. CLI flags:   --portal ws://host:8080/ws  --session lab  --name vm-1
//   2. Env vars:    CCPEEP_PORTAL, CCPEEP_SESSION, CCPEEP_NAME
//   3. config.json  next to the client root ({ "portal", "session", "name" })
//   4. Defaults.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import {
  Role,
  MessageType,
  SignalKind,
  hello,
  signal,
} from "../../shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

function loadFileConfig() {
  const file = path.join(CLIENT_ROOT, "config.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function resolveConfig() {
  const args = parseArgs(process.argv.slice(2));
  const file = loadFileConfig();
  return {
    portal:
      args.portal || process.env.CCPEEP_PORTAL || file.portal || "ws://localhost:8080/ws",
    session: args.session || process.env.CCPEEP_SESSION || file.session || "lab",
    name: args.name || process.env.CCPEEP_NAME || file.name || `vm-${process.env.COMPUTERNAME || "agent"}`,
  };
}

const config = resolveConfig();
const RECONNECT_MS = 3000;

let ws = null;
let myPeerId = null;
let reconnectTimer = null;

function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.info(`[${ts}]`, ...args);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  log(`connecting to portal ${config.portal} (session=${config.session}, name=${config.name})`);
  ws = new WebSocket(config.portal);

  ws.on("open", () => {
    log("connected — announcing presence as vm-agent");
    send(hello({ sessionId: config.session, role: Role.VM_AGENT, name: config.name }));
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handleMessage(msg);
  });

  ws.on("close", () => {
    log(`disconnected — retrying in ${RECONNECT_MS / 1000}s`);
    scheduleReconnect();
  });

  ws.on("error", (err) => log("ws error:", err.message));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function handleMessage(msg) {
  switch (msg.type) {
    case MessageType.WELCOME:
      myPeerId = msg.peerId;
      log(`welcome: peerId=${msg.peerId} session=${msg.sessionId}`);
      break;
    case MessageType.PRESENCE: {
      const others = msg.peers.filter((p) => p.peerId !== myPeerId);
      log(`presence: ${msg.peers.length} peer(s) — ${others.map((p) => `${p.name}(${p.role})`).join(", ") || "alone"}`);
      break;
    }
    case MessageType.SIGNAL:
      handleSignal(msg);
      break;
    case MessageType.BYE:
      log(`peer left: ${msg.peerId}`);
      break;
    case MessageType.ERROR:
      log(`portal error: ${msg.code} — ${msg.message}`);
      break;
    default:
      log("unhandled message:", msg.type);
  }
}

// WebRTC signaling passthrough. A full agent answers offers from the web client and
// streams audio over the negotiated connection.
function handleSignal(msg) {
  switch (msg.kind) {
    case SignalKind.OFFER:
      log(`offer from ${msg.from} — audio negotiation not yet implemented (see TODO)`);
      // TODO: feed offer into a WebRTC peer (SIPSorcery/.NET sidecar) and reply with
      //       an answer via send(signal({ to: msg.from, kind: SignalKind.ANSWER, data })).
      // TODO: capture system/loopback audio with NAudio (WASAPI) -> audio.out track.
      // TODO: play received audio.in track into the VM's audio device.
      break;
    case SignalKind.ANSWER:
      log(`answer from ${msg.from}`);
      break;
    case SignalKind.CANDIDATE:
      log(`ICE candidate from ${msg.from}`);
      break;
    default:
      log("unknown signal kind:", msg.kind);
  }
}

function shutdown(reason) {
  log(`shutting down (${reason})`);
  try {
    ws?.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("audio-agents Windows client starting");
connect();
