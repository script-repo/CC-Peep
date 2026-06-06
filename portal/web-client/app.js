// Browser client: connects to the portal signaling server, shows presence, and
// negotiates a WebRTC audio session (mic out -> peer, peer audio -> speakers).
//
// Imports the shared protocol served by the portal at /shared/protocol.js so the
// browser and server agree on message shapes.

import {
  Role,
  SignalKind,
  hello,
  signal,
} from "/shared/protocol.js";

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
  remote: $("remote"),
  log: $("log"),
};

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

let ws = null;
let myPeerId = null;
let micStream = null;
/** @type {Map<string, RTCPeerConnection>} remotePeerId -> pc */
const pcs = new Map();

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

function connect() {
  ws = new WebSocket(wsUrl());
  setStatus("connecting…");

  ws.onopen = () => {
    ws.send(
      JSON.stringify(
        hello({
          sessionId: els.session.value.trim() || "lab",
          role: Role.WEB_CLIENT,
          name: els.name.value.trim() || "browser",
        }),
      ),
    );
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };

  ws.onclose = () => {
    setStatus("disconnected");
    els.connect.disabled = false;
    els.disconnect.disabled = true;
    els.mic.disabled = true;
    els.peers.innerHTML = '<li class="muted">not connected</li>';
    for (const pc of pcs.values()) pc.close();
    pcs.clear();
  };

  ws.onerror = () => log("[ws] error");
}

function disconnect() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  ws?.close();
}

function handleMessage(msg) {
  switch (msg.type) {
    case "welcome":
      myPeerId = msg.peerId;
      setStatus("connected");
      els.connect.disabled = true;
      els.disconnect.disabled = false;
      els.mic.disabled = false;
      log(`[welcome] peerId=${msg.peerId} session=${msg.sessionId}`);
      break;
    case "presence":
      renderPeers(msg.peers);
      break;
    case "signal":
      onSignal(msg);
      break;
    case "bye":
      log(`[bye] peer ${msg.peerId} left`);
      pcs.get(msg.peerId)?.close();
      pcs.delete(msg.peerId);
      break;
    case "error":
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

function newPeerConnection(remoteId) {
  const pc = new RTCPeerConnection(ICE);
  pcs.set(remoteId, pc);

  if (micStream) {
    for (const track of micStream.getTracks()) pc.addTrack(track, micStream);
  }

  pc.ontrack = (ev) => {
    els.remote.srcObject = ev.streams[0];
    els.audioState.textContent = "Receiving audio from peer.";
    log(`[rtc] remote track from ${remoteId}`);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      send(signal({ to: remoteId, kind: SignalKind.CANDIDATE, data: ev.candidate }));
    }
  };

  pc.onconnectionstatechange = () => log(`[rtc] ${remoteId} ${pc.connectionState}`);
  return pc;
}

async function startAudio() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    els.audioState.textContent = "Microphone live. Offering audio to peers in the session.";
    els.mic.disabled = true;
    log("[mic] capture started");

    // Offer to every other peer currently in the session.
    const items = [...els.peers.querySelectorAll("li.peer")];
    // We re-derive peers from presence rather than DOM; offer on next presence too.
    // Immediately offer to known peers:
    for (const [remoteId] of pcs) await makeOffer(remoteId);
  } catch (err) {
    els.audioState.textContent = "Microphone permission denied or unavailable.";
    log(`[mic] error: ${err.message}`);
  }
}

async function makeOffer(remoteId) {
  let pc = pcs.get(remoteId);
  if (!pc) pc = newPeerConnection(remoteId);
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  send(signal({ to: remoteId, kind: SignalKind.OFFER, data: offer }));
  log(`[rtc] offer -> ${remoteId}`);
}

async function onSignal(msg) {
  const remoteId = msg.from;
  let pc = pcs.get(remoteId);
  if (!pc) pc = newPeerConnection(remoteId);

  if (msg.kind === SignalKind.OFFER) {
    await pc.setRemoteDescription(msg.data);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send(signal({ to: remoteId, kind: SignalKind.ANSWER, data: answer }));
    log(`[rtc] answer -> ${remoteId}`);
  } else if (msg.kind === SignalKind.ANSWER) {
    await pc.setRemoteDescription(msg.data);
  } else if (msg.kind === SignalKind.CANDIDATE) {
    try {
      await pc.addIceCandidate(msg.data);
    } catch (err) {
      log(`[rtc] addIceCandidate failed: ${err.message}`);
    }
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

els.connect.addEventListener("click", connect);
els.disconnect.addEventListener("click", disconnect);
els.mic.addEventListener("click", startAudio);
