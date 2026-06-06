// Browser client (WebSocket relay model): shows presence, plays PCM audio streamed
// from the VM (audio.out), and captures the mic to stream back to the VM (audio.in).
//
// Wire format: an `audio-format` control message describes the PCM, then raw binary
// frames carry interleaved little-endian 16-bit PCM. The portal relays both.

import { Role, MessageType, AudioChannel, AUDIO_DEFAULTS, hello, audioFormat } from "/shared/protocol.js";

const $ = (id) => document.getElementById(id);
const els = {
  dot: $("status-dot"),
  statusText: $("status-text"),
  session: $("session"),
  name: $("name"),
  connect: $("connect"),
  disconnect: $("disconnect"),
  peers: $("peers"),
  mic: $("mic"),
  audioState: $("audio-state"),
  log: $("log"),
};

let ws = null;
let myPeerId = null;

// --- playback (audio.out from VM) ---
let playCtx = null;
let playFormat = null; // { sampleRate, channels, bits }
let nextPlayTime = 0;

// --- capture (audio.in to VM) ---
let micCtx = null;
let micStream = null;
let micNode = null;
let micSource = null;
const MIC_RATE = AUDIO_DEFAULTS.sampleRate; // 16000

function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  els.log.textContent += line + "\n";
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(state) {
  els.dot.className = "dot " + (state === "connected" ? "on" : "off");
  els.statusText.textContent = state;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  setStatus("connecting…");

  ws.onopen = () => {
    send(hello({
      sessionId: els.session.value.trim() || "lab",
      role: Role.WEB_CLIENT,
      name: els.name.value.trim() || "browser",
    }));
  };

  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      onAudioFrame(ev.data);
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    setStatus("disconnected");
    els.connect.disabled = false;
    els.disconnect.disabled = true;
    els.mic.disabled = true;
    els.peers.innerHTML = '<li class="muted">not connected</li>';
    stopMic();
    teardownPlayback();
  };

  ws.onerror = () => log("[ws] error");
}

function disconnect() {
  stopMic();
  ws?.close();
}

function handleMessage(msg) {
  switch (msg.type) {
    case MessageType.WELCOME:
      myPeerId = msg.peerId;
      setStatus("connected");
      els.connect.disabled = true;
      els.disconnect.disabled = false;
      els.mic.disabled = false;
      log(`[welcome] peerId=${msg.peerId} session=${msg.sessionId}`);
      break;
    case MessageType.PRESENCE:
      renderPeers(msg.peers);
      break;
    case MessageType.AUDIO_FORMAT:
      if (msg.channel === AudioChannel.OUT) {
        playFormat = { sampleRate: msg.sampleRate, channels: msg.channels, bits: msg.bits };
        setupPlayback();
        log(`[audio] VM stream: ${msg.sampleRate}Hz ${msg.channels}ch ${msg.bits}-bit`);
        els.audioState.textContent = "Receiving audio from the VM.";
      }
      break;
    case MessageType.BYE:
      log(`[bye] peer ${msg.peerId} left`);
      break;
    case MessageType.ERROR:
      log(`[error] ${msg.code}: ${msg.message}`);
      break;
  }
}

function renderPeers(peers) {
  els.peers.innerHTML = "";
  const others = peers.filter((p) => p.peerId !== myPeerId);
  if (!others.length) {
    els.peers.innerHTML = '<li class="muted">waiting for the VM agent or another peer…</li>';
  }
  for (const p of peers) {
    const li = document.createElement("li");
    li.className = "peer";
    const isVm = p.role === Role.VM_AGENT;
    li.innerHTML =
      `<span class="tag ${isVm ? "vm" : ""}">${p.role}</span>` +
      `<span>${p.name}</span>` +
      (p.peerId === myPeerId ? '<span class="muted">(you)</span>' : "");
    els.peers.appendChild(li);
  }
}

// ---- Playback: schedule incoming PCM frames on the Web Audio clock ----

function setupPlayback() {
  if (!playCtx) {
    playCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  playCtx.resume?.();
  nextPlayTime = playCtx.currentTime + 0.1; // small startup buffer
}

function teardownPlayback() {
  playCtx?.close?.();
  playCtx = null;
  playFormat = null;
}

function onAudioFrame(arrayBuffer) {
  // The relay format is fixed (mono 16-bit @ AUDIO_DEFAULTS). If we never received an
  // explicit audio-format (e.g. we joined after the VM started capturing), assume it so
  // late joiners still play audio instead of silently dropping frames.
  if (!playFormat) playFormat = { sampleRate: AUDIO_DEFAULTS.sampleRate, channels: 1, bits: 16 };
  if (!playCtx) setupPlayback();
  if (!playCtx || !playFormat) return;
  const view = new DataView(arrayBuffer);
  const samples = arrayBuffer.byteLength / 2; // 16-bit
  const channels = playFormat.channels || 1;
  const frames = Math.floor(samples / channels);
  if (frames === 0) return;

  const buffer = playCtx.createBuffer(channels, frames, playFormat.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const out = buffer.getChannelData(ch);
    for (let i = 0; i < frames; i++) {
      const int16 = view.getInt16((i * channels + ch) * 2, true);
      out[i] = int16 / 32768;
    }
  }

  const src = playCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.05; // re-sync if we fell behind
  src.start(nextPlayTime);
  nextPlayTime += buffer.duration;
}

// ---- Capture: mic -> downsample to 16k mono int16 -> binary frames ----

async function startMic() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      els.audioState.textContent =
        "Microphone unavailable: this page must be served over HTTPS (secure context).";
      log("[mic] navigator.mediaDevices is undefined — needs HTTPS or localhost.");
      return;
    }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // Start playback under this user gesture so the AudioContext isn't left suspended,
    // and default the play format in case the VM's audio-format message was missed.
    if (!playFormat) playFormat = { sampleRate: AUDIO_DEFAULTS.sampleRate, channels: 1, bits: 16 };
    setupPlayback();

    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    micSource = micCtx.createMediaStreamSource(micStream);
    micNode = micCtx.createScriptProcessor(4096, 1, 1);

    send(audioFormat({ channel: AudioChannel.IN, sampleRate: MIC_RATE, channels: 1, bits: 16 }));

    micNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const down = downsample(input, micCtx.sampleRate, MIC_RATE);
      const pcm = floatToInt16(down);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
    };

    micSource.connect(micNode);
    micNode.connect(micCtx.destination); // keeps the node alive in all browsers
    els.mic.disabled = true;
    els.audioState.textContent = "Microphone live — streaming to the VM (audio.in).";
    log(`[mic] capturing; downsampling ${micCtx.sampleRate}Hz -> ${MIC_RATE}Hz mono`);
  } catch (err) {
    els.audioState.textContent = `Microphone error: ${err.message}`;
    log(`[mic] error: ${err.message}`);
  }
}

function stopMic() {
  try { micNode?.disconnect(); } catch {}
  try { micSource?.disconnect(); } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  micCtx?.close?.();
  micNode = micSource = micStream = micCtx = null;
}

function downsample(input, inRate, outRate) {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = input[Math.floor(i * ratio)];
  }
  return out;
}

function floatToInt16(floats) {
  const out = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

els.connect.addEventListener("click", connect);
els.disconnect.addEventListener("click", disconnect);
els.mic.addEventListener("click", startMic);
