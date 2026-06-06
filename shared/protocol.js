// Shared presence + WebRTC signaling protocol.
//
// Transport: WebSocket carries these JSON control messages only. Audio media flows
// out-of-band over WebRTC once signaling completes.
//
// This is a plain ESM module with no dependencies so it can be imported by the
// Node.js server and (via a bundler or direct <script type="module">) the browser.

/** Roles a peer can announce when it joins a session. */
export const Role = Object.freeze({
  VM_AGENT: "vm-agent",
  WEB_CLIENT: "web-client",
});

/** WebSocket control message types. */
export const MessageType = Object.freeze({
  // client -> server: announce presence and join a session
  HELLO: "hello",
  // server -> client: acknowledge join, assign a peerId
  WELCOME: "welcome",
  // server -> clients: current roster of peers in the session
  PRESENCE: "presence",
  // client -> server -> client: WebRTC signaling passthrough (offer/answer/candidate)
  SIGNAL: "signal",
  // client -> server -> clients: describes the PCM format of the binary audio frames
  // that follow on this connection (sample rate / channels / bit depth)
  AUDIO_FORMAT: "audio-format",
  // server -> clients: a peer left
  BYE: "bye",
  // server -> client: protocol/usage error
  ERROR: "error",
});

/** Kinds of WebRTC signaling payload carried inside a SIGNAL message. */
export const SignalKind = Object.freeze({
  OFFER: "offer",
  ANSWER: "answer",
  CANDIDATE: "candidate",
});

/** Logical audio channels. */
export const AudioChannel = Object.freeze({
  // VM system/loopback audio -> browser speakers
  OUT: "audio.out",
  // browser microphone -> VM
  IN: "audio.in",
});

// --- Audio relay (WebSocket transport) ---
//
// In the relay model the WebSocket also carries audio: each peer sends an
// `audio-format` control message describing its PCM, then streams raw interleaved
// PCM as binary WebSocket frames. The server forwards both to the other peers in the
// session (it does not transcode). Frames are little-endian signed 16-bit by default.
export const AUDIO_DEFAULTS = Object.freeze({
  sampleRate: 16000,
  channels: 1,
  bits: 16,
});

// --- Message builders (keep envelopes consistent across components) ---

export function hello({ sessionId, role, name }) {
  return { type: MessageType.HELLO, sessionId, role, name };
}

export function welcome({ peerId, sessionId }) {
  return { type: MessageType.WELCOME, peerId, sessionId };
}

export function presence({ sessionId, peers }) {
  return { type: MessageType.PRESENCE, sessionId, peers };
}

/**
 * WebRTC signaling passthrough.
 * @param {object} a
 * @param {string} a.to     - target peerId
 * @param {string} [a.from] - source peerId (server stamps this on relay)
 * @param {string} a.kind   - one of SignalKind
 * @param {object} a.data   - SDP description or ICE candidate
 */
export function signal({ to, from, kind, data }) {
  return { type: MessageType.SIGNAL, to, from, kind, data };
}

/**
 * Describes the PCM format of the binary audio frames that follow.
 * @param {object} a
 * @param {string} a.channel    - AudioChannel.OUT (VM->browser) or AudioChannel.IN (browser->VM)
 * @param {number} a.sampleRate - samples per second (e.g. 16000)
 * @param {number} a.channels   - interleaved channel count (1 = mono)
 * @param {number} a.bits       - bits per sample (16)
 * @param {string} [a.from]     - source peerId (server stamps this on relay)
 */
export function audioFormat({ channel, sampleRate, channels, bits, from }) {
  return { type: MessageType.AUDIO_FORMAT, channel, sampleRate, channels, bits, from };
}

export function bye({ peerId }) {
  return { type: MessageType.BYE, peerId };
}

export function error({ code, message }) {
  return { type: MessageType.ERROR, code, message };
}

/** Default session id when a client doesn't specify one. */
export const DEFAULT_SESSION = "lab";
