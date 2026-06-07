// CC-Peep audio bridge for Linux (PulseAudio / PipeWire).
//
// The Linux counterpart of client/audio-ps/audio-bridge.ps1. It connects to the portal
// over the WebSocket relay and uses ffmpeg to move PCM audio in/out of the machine:
//
//   audio.out  capture a Pulse source (e.g. a sink monitor) -> browser
//   audio.in   browser mic -> play into a Pulse sink
//
// The wire format matches every other peer: an `audio-format` control message, then raw
// little-endian signed 16-bit mono PCM at SampleRate as binary WebSocket frames.
//
// Run:
//   node audio-bridge.mjs --portal wss://HOST:8080/ws --session lab \
//        --capture-source @DEFAULT_MONITOR@ --playback-sink @DEFAULT_SINK@
//
// Config (first match wins): CLI flags, then CCPEEP_* env vars, then defaults.
//   --portal/CCPEEP_PORTAL            ws(s)://host:8080/ws
//   --session/CCPEEP_SESSION          session id (default: lab)
//   --name/CCPEEP_NAME                display name (default: linux-<hostname>)
//   --direction/CCPEEP_DIRECTION      both | out | in (default: both)
//   --rate/CCPEEP_RATE                relay sample rate (default: 16000)
//   --capture-source/CCPEEP_CAPTURE_SOURCE   Pulse source for audio.out
//   --playback-sink/CCPEEP_PLAYBACK_SINK     Pulse sink for audio.in
//   CCPEEP_TLS_STRICT=1               verify TLS for wss:// (default: accept self-signed)

import os from "node:os";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

import { Role, MessageType, AudioChannel, hello, audioFormat } from "../../shared/protocol.js";

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

const args = parseArgs(process.argv.slice(2));
const cfg = {
  portal: args.portal || process.env.CCPEEP_PORTAL || "ws://localhost:8080/ws",
  session: args.session || process.env.CCPEEP_SESSION || "lab",
  name: args.name || process.env.CCPEEP_NAME || `linux-${os.hostname()}`,
  direction: args.direction || process.env.CCPEEP_DIRECTION || "both",
  rate: parseInt(args.rate || process.env.CCPEEP_RATE || "16000", 10),
  // @DEFAULT_MONITOR@ = the monitor of the default sink (captures what is playing).
  captureSource: args["capture-source"] || process.env.CCPEEP_CAPTURE_SOURCE || "@DEFAULT_MONITOR@",
  playbackSink: args["playback-sink"] || process.env.CCPEEP_PLAYBACK_SINK || "@DEFAULT_SINK@",
  // ffmpeg input/output backend: "pulse" (default) or "alsa" (e.g. hw:Loopback,1,0).
  captureFormat: args["capture-format"] || process.env.CCPEEP_CAPTURE_FORMAT || "pulse",
  playbackFormat: args["playback-format"] || process.env.CCPEEP_PLAYBACK_FORMAT || "pulse",
  // Echo mode: return received audio.in frames straight back as audio.out. No audio
  // devices needed - use it to test the browser <-> portal <-> client path end to end.
  loopback: args.loopback !== undefined || process.env.CCPEEP_LOOPBACK === "1",
};

const RECONNECT_MS = 3000;
let ws = null;
let reconnectTimer = null;
let capture = null;
let playback = null;

function log(...a) {
  console.info(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

function sendText(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// audio.out: capture a source -> mono s16le @rate -> binary frames to the portal.
function startCapture() {
  const a = ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", cfg.captureFormat];
  // ALSA loopback devices must be opened at the exact rate/format, so fix input params.
  if (cfg.captureFormat === "alsa") a.push("-ar", String(cfg.rate), "-ac", "1");
  a.push("-i", cfg.captureSource, "-ac", "1", "-ar", String(cfg.rate), "-f", "s16le", "-");
  capture = spawn("ffmpeg", a);
  log(`audio.out capturing '${cfg.captureSource}' -> ${cfg.rate}Hz mono 16-bit`);
  sendText(audioFormat({ channel: AudioChannel.OUT, sampleRate: cfg.rate, channels: 1, bits: 16 }));
  capture.stdout.on("data", (chunk) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
  });
  capture.stderr.on("data", (d) => log("ffmpeg(capture):", d.toString().trim()));
  capture.on("error", (e) => log("audio.out failed to start ffmpeg:", e.message));
  capture.on("exit", (code) => { if (code) log(`audio.out ffmpeg exited (${code})`); });
}

// audio.in: receive binary frames from the portal -> play into a Pulse sink.
function startPlayback() {
  const a = [
    "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", String(cfg.rate), "-ac", "1", "-i", "-",
    "-f", cfg.playbackFormat, cfg.playbackSink,
  ];
  playback = spawn("ffmpeg", a);
  log(`audio.in playback -> sink '${cfg.playbackSink}' (${cfg.rate}Hz mono 16-bit)`);
  playback.stderr.on("data", (d) => log("ffmpeg(playback):", d.toString().trim()));
  playback.on("error", (e) => log("audio.in failed to start ffmpeg:", e.message));
  playback.on("exit", (code) => { if (code) log(`audio.in ffmpeg exited (${code})`); });
}

function stopMedia() {
  try { capture?.kill("SIGKILL"); } catch {}
  try { playback?.kill("SIGKILL"); } catch {}
  capture = playback = null;
}

function connect() {
  log(`connecting to ${cfg.portal} (session=${cfg.session}, name=${cfg.name}, direction=${cfg.direction})`);
  const opts = {};
  if (cfg.portal.startsWith("wss:") && process.env.CCPEEP_TLS_STRICT !== "1") {
    opts.rejectUnauthorized = false;
  }
  ws = new WebSocket(cfg.portal, opts);

  ws.on("open", () => {
    log("connected; announcing presence as vm-agent");
    sendText(hello({ sessionId: cfg.session, role: Role.VM_AGENT, name: cfg.name }));
    if (cfg.loopback) {
      sendText(audioFormat({ channel: AudioChannel.OUT, sampleRate: cfg.rate, channels: 1, bits: 16 }));
      log("loopback/echo mode: returning audio.in frames as audio.out (no audio devices used)");
      return;
    }
    if (cfg.direction !== "in") startCapture();
    if (cfg.direction !== "out") startPlayback();
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (cfg.loopback) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
        return;
      }
      if (playback && playback.stdin.writable) playback.stdin.write(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === MessageType.WELCOME) log(`welcome: peerId=${msg.peerId} session=${msg.sessionId}`);
    else if (msg.type === MessageType.PRESENCE) {
      const others = msg.peers.filter((p) => p.peerId !== msg.peerId);
      log(`presence: ${msg.peers.length} peer(s) - ${others.map((p) => `${p.name}(${p.role})`).join(", ") || "alone"}`);
    } else if (msg.type === MessageType.ERROR) log(`portal error: ${msg.code} - ${msg.message}`);
  });

  ws.on("close", () => {
    log(`disconnected; retrying in ${RECONNECT_MS / 1000}s`);
    stopMedia();
    scheduleReconnect();
  });
  ws.on("error", (err) => log("ws error:", err.message));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
}

function shutdown(reason) {
  log(`shutting down (${reason})`);
  stopMedia();
  try { ws?.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("CC-Peep Linux audio bridge starting");
connect();
