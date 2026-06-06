// Presence + WebRTC signaling hub.
//
// Tracks peers grouped into sessions and routes control messages between them.
// Knows nothing about audio — it only brokers `hello`/`presence`/`signal`/`bye`.

import { randomUUID } from "node:crypto";
import {
  MessageType,
  Role,
  DEFAULT_SESSION,
  welcome,
  presence,
  signal,
  audioFormat,
  bye,
  error,
} from "../../../shared/protocol.js";

/** @typedef {{ peerId: string, role: string, name: string, send: (obj: object) => void, sendBinary: (buf: Buffer) => void }} Peer */

export class SignalingHub {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    /** @type {Map<string, Map<string, Peer>>} sessionId -> (peerId -> Peer) */
    this.sessions = new Map();
  }

  /**
   * Register a freshly connected socket. Returns a handle the transport uses to
   * deliver inbound messages and signal disconnect.
   * @param {(obj: object) => void} send - serialize + write a message to this socket
   * @param {(buf: Buffer) => void} sendBinary - write a binary frame to this socket
   */
  connect(send, sendBinary = () => {}) {
    const peerId = randomUUID();
    let sessionId = null;

    const handleMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        send(error({ code: "bad_json", message: "Message was not valid JSON" }));
        return;
      }

      switch (msg.type) {
        case MessageType.HELLO:
          sessionId = this.#onHello({ peerId, msg, send, sendBinary });
          break;
        case MessageType.SIGNAL:
          this.#onSignal({ peerId, sessionId, msg, send });
          break;
        case MessageType.AUDIO_FORMAT:
          // Stamp the sender and fan out to the other peers in the session.
          this.#relayToOthers(sessionId, peerId, (peer) =>
            peer.send(audioFormat({ ...msg, from: peerId })));
          break;
        default:
          send(error({ code: "unknown_type", message: `Unknown message type: ${msg.type}` }));
      }
    };

    // Raw binary = audio PCM. Forward verbatim to the other peers in the session.
    const handleBinary = (buf) => {
      this.#relayToOthers(sessionId, peerId, (peer) => peer.sendBinary(buf));
    };

    const handleClose = () => {
      if (!sessionId) return;
      const peers = this.sessions.get(sessionId);
      if (!peers || !peers.has(peerId)) return;
      const { role } = peers.get(peerId);
      peers.delete(peerId);
      this.logger.info(`[hub] peer left  session=${sessionId} peer=${peerId} role=${role}`);
      this.#broadcast(sessionId, bye({ peerId }));
      this.#broadcastPresence(sessionId);
      if (peers.size === 0) this.sessions.delete(sessionId);
    };

    return { peerId, handleMessage, handleBinary, handleClose };
  }

  #onHello({ peerId, msg, send, sendBinary }) {
    const role = Object.values(Role).includes(msg.role) ? msg.role : Role.WEB_CLIENT;
    const sessionId = msg.sessionId || DEFAULT_SESSION;
    const name = msg.name || role;

    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Map());
    const peers = this.sessions.get(sessionId);
    peers.set(peerId, { peerId, role, name, send, sendBinary });

    this.logger.info(`[hub] peer join  session=${sessionId} peer=${peerId} role=${role}`);
    send(welcome({ peerId, sessionId }));
    this.#broadcastPresence(sessionId);
    return sessionId;
  }

  #onSignal({ peerId, sessionId, msg, send }) {
    if (!sessionId) {
      send(error({ code: "not_joined", message: "Send a hello before signaling" }));
      return;
    }
    const peers = this.sessions.get(sessionId);
    const target = peers && peers.get(msg.to);
    if (!target) {
      send(error({ code: "no_such_peer", message: `No peer ${msg.to} in session` }));
      return;
    }
    // Stamp the sender so the recipient knows who to answer.
    target.send(signal({ to: msg.to, from: peerId, kind: msg.kind, data: msg.data }));
  }

  // Invoke fn for every peer in the session except the sender.
  #relayToOthers(sessionId, fromPeerId, fn) {
    if (!sessionId) return;
    const peers = this.sessions.get(sessionId);
    if (!peers) return;
    for (const peer of peers.values()) {
      if (peer.peerId !== fromPeerId) fn(peer);
    }
  }

  #roster(sessionId) {
    const peers = this.sessions.get(sessionId);
    if (!peers) return [];
    return [...peers.values()].map(({ peerId, role, name }) => ({ peerId, role, name }));
  }

  #broadcastPresence(sessionId) {
    this.#broadcast(sessionId, presence({ sessionId, peers: this.#roster(sessionId) }));
  }

  #broadcast(sessionId, obj) {
    const peers = this.sessions.get(sessionId);
    if (!peers) return;
    for (const peer of peers.values()) peer.send(obj);
  }
}
