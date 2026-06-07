// Switchboard: a 3D patchbay (three.js) for choosing audio routing per peer.
//
// Top rail  = SEND:    your MIC  -> a peer's IN jack   (adds peer to outTargets)
// Bottom rail = RECEIVE: a peer's OUT jack -> your SPK (adds peer to inSources)
//
// Patching a cable sends a `route` message so the portal relays audio only along the
// patched links. Audio capture/playback mirrors the simple web client.

import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { Role, MessageType, AudioChannel, AUDIO_DEFAULTS, hello, audioFormat, route } from "/shared/protocol.js";

// ---------------------------------------------------------------- DOM + state
const $ = (id) => document.getElementById(id);
const els = {
  dot: $("status-dot"), statusText: $("status-text"),
  session: $("session"), name: $("name"),
  connect: $("connect"), disconnect: $("disconnect"), mic: $("mic"), log: $("log"),
};
function log(...a) {
  els.log.textContent += a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
  els.log.scrollTop = els.log.scrollHeight;
}
function setStatus(s) {
  els.dot.className = "dot " + (s === "connected" ? "on" : "off");
  els.statusText.textContent = s;
}

let ws = null;
let myPeerId = null;
let peers = []; // [{peerId, role, name}] excluding me

// ---------------------------------------------------------------- WebSocket
function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
function sendObj(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

function connect() {
  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  setStatus("connecting");
  ws.onopen = () => sendObj(hello({
    sessionId: els.session.value.trim() || "lab",
    role: Role.WEB_CLIENT,
    name: els.name.value.trim() || "operator",
  }));
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) return onAudioFrame(ev.data);
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleMessage(m);
  };
  ws.onclose = () => {
    setStatus("disconnected");
    els.connect.disabled = false; els.disconnect.disabled = true; els.mic.disabled = true;
    stopMic(); teardownPlayback();
    peers = []; rebuildPeerJacks();
  };
  ws.onerror = () => log("[ws] error");
}
function disconnect() { stopMic(); ws?.close(); }

function handleMessage(m) {
  switch (m.type) {
    case MessageType.WELCOME:
      myPeerId = m.peerId; setStatus("connected");
      els.connect.disabled = true; els.disconnect.disabled = false; els.mic.disabled = false;
      log(`[welcome] ${m.peerId} session=${m.sessionId}`);
      break;
    case MessageType.PRESENCE: {
      peers = m.peers.filter((p) => p.peerId !== myPeerId);
      rebuildPeerJacks();
      break;
    }
    case MessageType.AUDIO_FORMAT:
      if (m.channel === AudioChannel.OUT) { ensurePlayFormat(m); setupPlayback(); }
      break;
  }
}

// ---------------------------------------------------------------- routing
function pushRoutes() {
  const outTargets = [];
  const inSources = [];
  for (const c of cables) {
    if (!c.complete) continue;
    if (c.kind === "send") outTargets.push(c.peerId);
    else if (c.kind === "recv") inSources.push(c.peerId);
  }
  sendObj(route({ outTargets, inSources }));
  log(`[route] send->[${outTargets.length}] recv<-[${inSources.length}]`);
}

// ---------------------------------------------------------------- audio I/O
let playCtx = null, playFormat = null, nextPlayTime = 0;
let micCtx = null, micStream = null, micNode = null, micSource = null;
const MIC_RATE = AUDIO_DEFAULTS.sampleRate;

function ensurePlayFormat(m) {
  playFormat = { sampleRate: m?.sampleRate || MIC_RATE, channels: m?.channels || 1, bits: m?.bits || 16 };
}
function setupPlayback() {
  if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)();
  playCtx.resume?.();
  if (!playFormat) ensurePlayFormat();
  nextPlayTime = playCtx.currentTime + 0.1;
}
function teardownPlayback() { playCtx?.close?.(); playCtx = null; playFormat = null; }
function onAudioFrame(buf) {
  if (!playFormat) ensurePlayFormat();
  if (!playCtx) setupPlayback();
  if (!playCtx) return;
  const view = new DataView(buf);
  const ch = playFormat.channels || 1;
  const frames = Math.floor((buf.byteLength / 2) / ch);
  if (!frames) return;
  const ab = playCtx.createBuffer(ch, frames, playFormat.sampleRate);
  for (let c = 0; c < ch; c++) {
    const out = ab.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] = view.getInt16((i * ch + c) * 2, true) / 32768;
  }
  const src = playCtx.createBufferSource();
  src.buffer = ab; src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.05;
  src.start(nextPlayTime); nextPlayTime += ab.duration;
}
async function startMic() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) { log("[mic] needs HTTPS/localhost"); return; }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    ensurePlayFormat(); setupPlayback();
    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    micSource = micCtx.createMediaStreamSource(micStream);
    micNode = micCtx.createScriptProcessor(4096, 1, 1);
    sendObj(audioFormat({ channel: AudioChannel.IN, sampleRate: MIC_RATE, channels: 1, bits: 16 }));
    micNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const down = downsample(input, micCtx.sampleRate, MIC_RATE);
      const pcm = floatToInt16(down);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
    };
    micSource.connect(micNode); micNode.connect(micCtx.destination);
    els.mic.disabled = true;
    log(`[mic] live; ${micCtx.sampleRate}->${MIC_RATE}Hz mono`);
  } catch (err) { log(`[mic] error: ${err.message}`); }
}
function stopMic() {
  try { micNode?.disconnect(); micSource?.disconnect(); } catch {}
  micStream?.getTracks().forEach((t) => t.stop());
  micCtx?.close?.(); micNode = micSource = micStream = micCtx = null;
}
function downsample(input, inRate, outRate) {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate, outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}
function floatToInt16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); o[i] = s < 0 ? s * 32768 : s * 32767; }
  return o;
}

// ============================================================ three.js scene
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f17);
const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
camera.position.set(0, -1.0, 23);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(-6, 10, 14); scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.35); rim.position.set(8, -6, 6); scene.add(rim);

// vintage panel
const panel = new THREE.Mesh(
  new THREE.BoxGeometry(22, 13, 0.6),
  new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.85, metalness: 0.3 }));
panel.position.z = -0.4; scene.add(panel);
const railTop = new THREE.Mesh(new THREE.BoxGeometry(21, 0.08, 0.1), new THREE.MeshStandardMaterial({ color: 0x3a2f24 }));
railTop.position.set(0, 3.05, -0.05); scene.add(railTop);
const railBot = railTop.clone(); railBot.position.y = -3.05; scene.add(railBot);

const JACK = { mic: { x: -7.5, y: 3, type: "mic" }, spk: { x: -7.5, y: -3, type: "spk" } };
const SNAP = 1.2;
const PALETTE = [0xef4444, 0xf59e0b, 0x10b981, 0x3b82f6, 0xa855f7, 0xec4899, 0x22d3ee, 0xeab308];

const jacks = new Map(); // id -> {id, type, peerId, pos:Vector3, mesh, ledMesh}
const cables = [];       // {kind:'send'|'recv', peerId, aJackId, bJackId|null, complete, group, color, free:Vector3}
let dragging = null;     // {cable, end:'b', }

// Build a crisp text sprite sized to fit the text (no clipping/overlap), rendered
// on top of the panel. World height is fixed; width follows the measured text.
function makeLabel(text, color = "#dbe3ef", size = 48, worldH = 0.62) {
  const font = `600 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const c = document.createElement("canvas");
  let ctx = c.getContext("2d");
  ctx.font = font;
  const pad = 18;
  c.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  c.height = size + pad * 2;
  ctx = c.getContext("2d");
  ctx.font = font; ctx.fillStyle = color;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4; tex.minFilter = THREE.LinearFilter;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(worldH * (c.width / c.height), worldH, 1);
  spr.renderOrder = 20;
  return spr;
}

function addJack(id, type, x, y, peerId, labelText) {
  const g = new THREE.Group(); g.position.set(x, y, 0);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.12, 14, 28),
    new THREE.MeshStandardMaterial({ color: 0xb8a06a, roughness: 0.35, metalness: 0.9 }));
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.32, 24),
    new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 1 }));
  hole.position.z = 0.02;
  const led = new THREE.Mesh(new THREE.CircleGeometry(0.09, 16),
    new THREE.MeshStandardMaterial({ color: 0x10240f, emissive: 0x0a3d0a, emissiveIntensity: 0 }));
  led.position.set(0.0, 0.62, 0.05);
  g.add(ring, hole, led);
  if (labelText) {
    const top = type === "mic" || type === "pin";
    const l = makeLabel(labelText);
    l.position.set(0, top ? 1.0 : -1.0, 0.2);
    g.add(l);
  }
  scene.add(g);
  const pos = new THREE.Vector3(x, y, 0.1);
  jacks.set(id, { id, type, peerId, pos, mesh: ring, group: g, led });
}

function clearScene() {
  for (const { group } of jacks.values()) scene.remove(group);
  jacks.clear();
  for (const c of cables.splice(0)) scene.remove(c.group);
}

// (re)build jacks for ME + each peer and auto-patch new peers as "both".
let railLabels = [];
function rebuildPeerJacks() {
  const prev = new Map(cables.map((c) => [c.kind + ":" + c.peerId, c.complete]));
  clearScene();
  railLabels.forEach((l) => scene.remove(l)); railLabels = [];

  addJack("mic", "mic", JACK.mic.x, JACK.mic.y, null, "YOUR MIC");
  addJack("spk", "spk", JACK.spk.x, JACK.spk.y, null, "YOUR SPK");
  const sendLbl = makeLabel("SEND \u25B8 your mic to peers", "#7f8da3", 40, 0.5);
  sendLbl.position.set(-6, 5.3, 0.2); scene.add(sendLbl); railLabels.push(sendLbl);
  const recvLbl = makeLabel("RECEIVE \u25C2 peers to your speaker", "#7f8da3", 40, 0.5);
  recvLbl.position.set(-5.5, -5.3, 0.2); scene.add(recvLbl); railLabels.push(recvLbl);

  const n = peers.length;
  peers.forEach((p, i) => {
    const x = n <= 1 ? 2.5 : (-2.5 + i * (9.5 / (n - 1)));
    const short = (p.name || p.peerId).slice(0, 22);
    addJack("pin:" + p.peerId, "pin", x, 3, p.peerId, short);
    addJack("pout:" + p.peerId, "pout", x, -3, p.peerId, null);
    // restore previous patch state, or default to connected (both) for new peers.
    const send = prev.has("send:" + p.peerId) ? prev.get("send:" + p.peerId) : true;
    const recv = prev.has("recv:" + p.peerId) ? prev.get("recv:" + p.peerId) : true;
    if (send) makeCable("send", p.peerId, true);
    if (recv) makeCable("recv", p.peerId, true);
  });
  if (ws && ws.readyState === WebSocket.OPEN) pushRoutes();
}

function endpointsFor(kind, peerId) {
  return kind === "send"
    ? { a: "mic", b: "pin:" + peerId }
    : { a: "pout:" + peerId, b: "spk" };
}

function makeCable(kind, peerId, complete) {
  const { a, b } = endpointsFor(kind, peerId);
  const color = PALETTE[(cables.length) % PALETTE.length];
  const group = new THREE.Group(); scene.add(group);
  const cable = { kind, peerId, aJackId: a, bJackId: complete ? b : null, complete: !!complete, group, color, free: new THREE.Vector3() };
  cables.push(cable);
  redrawCable(cable);
  setLed(a, complete); setLed(b, complete);
  return cable;
}

function jackPos(id) { return jacks.get(id)?.pos; }

function setLed(jackId, on) {
  const j = jacks.get(jackId); if (!j) return;
  j.led.material.emissiveIntensity = on ? 1.4 : 0;
  j.led.material.color.setHex(on ? 0x16a34a : 0x10240f);
}

function cableEnds(cable) {
  const aPos = jackPos(cable.aJackId) || cable.free;
  const bPos = cable.bJackId ? jackPos(cable.bJackId) : cable.free;
  return [aPos, bPos];
}

function redrawCable(cable) {
  // dispose old meshes
  while (cable.group.children.length) {
    const m = cable.group.children.pop();
    m.geometry?.dispose?.();
  }
  const [p0, p1] = cableEnds(cable);
  const dist = p0.distanceTo(p1);
  const sag = 0.6 + dist * 0.28;
  const mid = p0.clone().add(p1).multiplyScalar(0.5);
  mid.y -= sag; mid.z += 0.2;
  const curve = new THREE.QuadraticBezierCurve3(p0.clone(), mid, p1.clone());
  const tube = new THREE.TubeGeometry(curve, 32, 0.11, 10, false);
  const mat = new THREE.MeshStandardMaterial({ color: cable.color, roughness: 0.5, metalness: 0.1 });
  cable.group.add(new THREE.Mesh(tube, mat));
  // plugs at each end
  const plugMat = new THREE.MeshStandardMaterial({ color: 0xd6d9de, roughness: 0.3, metalness: 0.95 });
  for (const p of [p0, p1]) {
    const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.5, 16), plugMat);
    plug.position.copy(p); plug.position.z += 0.18; plug.rotation.x = Math.PI / 2;
    cable.group.add(plug);
  }
}

// ---------------------------------------------------------------- interaction
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.1);

function pointerWorld(ev) {
  const r = canvas.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const out = new THREE.Vector3();
  raycaster.ray.intersectPlane(dragPlane, out);
  return out;
}

function nearestJack(pos, predicate) {
  let best = null, bestD = SNAP;
  for (const j of jacks.values()) {
    if (predicate && !predicate(j)) continue;
    const d = j.pos.distanceTo(pos);
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}

// which jack (if any) is under the pointer
function jackUnder(pos) { return nearestJack(pos, null); }

function compatible(typeA, typeB) {
  return (typeA === "mic" && typeB === "pin") || (typeA === "pin" && typeB === "mic")
      || (typeA === "spk" && typeB === "pout") || (typeA === "pout" && typeB === "spk");
}

function kindForPair(t1, t2) {
  if ((t1 === "mic" && t2 === "pin") || (t1 === "pin" && t2 === "mic")) return "send";
  if ((t1 === "spk" && t2 === "pout") || (t1 === "pout" && t2 === "spk")) return "recv";
  return null;
}

function cableForJack(jackId) {
  return cables.find((c) => c.complete && (c.aJackId === jackId || c.bJackId === jackId));
}

function removeCable(cable) {
  scene.remove(cable.group);
  const i = cables.indexOf(cable); if (i >= 0) cables.splice(i, 1);
  setLed(cable.aJackId, false);
  if (cable.bJackId) setLed(cable.bJackId, false);
}

function onPointerDown(ev) {
  if (!jacks.size) return;
  const pos = pointerWorld(ev);
  const j = jackUnder(pos);
  if (!j) return;
  // If this jack already has a cable, grab it (detach the far end to re-drag).
  const existing = cableForJack(j.id);
  if (existing) {
    // free the end that is NOT this jack so the user drags the loose plug
    const keepA = existing.aJackId === j.id;
    const fixedJackId = keepA ? existing.aJackId : existing.bJackId;
    existing.complete = false;
    existing.aJackId = fixedJackId;
    existing.bJackId = null;
    setLed(fixedJackId, false);
    if (keepA && existing.kind) {} // leds already cleared on both via redraw below
    existing.free.copy(pos);
    dragging = { cable: existing, anchorType: j.type };
    redrawCable(existing);
    canvas.style.cursor = "grabbing";
    return;
  }
  // Start a brand new cable anchored at this jack.
  const color = PALETTE[cables.length % PALETTE.length];
  const group = new THREE.Group(); scene.add(group);
  const cable = { kind: null, peerId: j.peerId, aJackId: j.id, bJackId: null, complete: false, group, color, free: pos.clone() };
  cables.push(cable);
  dragging = { cable, anchorType: j.type };
  redrawCable(cable);
  canvas.style.cursor = "grabbing";
}

function onPointerMove(ev) {
  if (!dragging) return;
  dragging.cable.free.copy(pointerWorld(ev));
  redrawCable(dragging.cable);
}

function onPointerUp(ev) {
  if (!dragging) return;
  const cable = dragging.cable;
  const pos = pointerWorld(ev);
  const anchorType = jacks.get(cable.aJackId)?.type;
  const target = nearestJack(pos, (j) => j.id !== cable.aJackId && compatible(anchorType, j.type));
  if (target) {
    const kind = kindForPair(anchorType, target.type);
    const peerId = target.peerId || cable.peerId;
    // prevent duplicate link to same peer+kind
    const dup = cables.find((c) => c !== cable && c.complete && c.kind === kind && c.peerId === peerId);
    if (dup) removeCable(dup);
    cable.kind = kind; cable.peerId = peerId; cable.bJackId = target.id; cable.complete = true;
    setLed(cable.aJackId, true); setLed(cable.bJackId, true);
    redrawCable(cable);
  } else {
    removeCable(cable); // dropped on nothing -> unplug
  }
  dragging = null;
  canvas.style.cursor = "default";
  // Always re-publish routing after any patch change (plug OR unplug), otherwise
  // the portal keeps relaying audio for links the operator just pulled.
  pushRoutes();
}

canvas.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);

// ---------------------------------------------------------------- render loop
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}
function tick() {
  resize();
  // gently pulse active LEDs
  const t = performance.now() * 0.004;
  for (const j of jacks.values()) {
    if (j.led.material.emissiveIntensity > 0) j.led.material.emissiveIntensity = 1.0 + Math.sin(t) * 0.4;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

els.connect.addEventListener("click", connect);
els.disconnect.addEventListener("click", disconnect);
els.mic.addEventListener("click", startMic);
