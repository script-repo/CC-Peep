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

/** Logical audio channels negotiated as WebRTC tracks. */
export const AudioChannel = Object.freeze({
  // VM system/loopback audio -> browser speakers
  OUT: "audio.out",
  // browser microphone -> VM
  IN: "audio.in",
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

export function bye({ peerId }) {
  return { type: MessageType.BYE, peerId };
}

export function error({ code, message }) {
  return { type: MessageType.ERROR, code, message };
}

/** Default session id when a client doesn't specify one. */
export const DEFAULT_SESSION = "lab";
