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
  bye,
  error,
} from "../../shared/protocol.js";

/** @typedef {{ peerId: string, role: string, name: string, send: (obj: object) => void }} Peer */

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
   */
  connect(send) {
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
          sessionId = this.#onHello({ peerId, msg, send });
          break;
        case MessageType.SIGNAL:
          this.#onSignal({ peerId, sessionId, msg, send });
          break;
        default:
          send(error({ code: "unknown_type", message: `Unknown message type: ${msg.type}` }));
      }
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

    return { peerId, handleMessage, handleClose };
  }

  #onHello({ peerId, msg, send }) {
    const role = Object.values(Role).includes(msg.role) ? msg.role : Role.WEB_CLIENT;
    const sessionId = msg.sessionId || DEFAULT_SESSION;
    const name = msg.name || role;

    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Map());
    const peers = this.sessions.get(sessionId);
    peers.set(peerId, { peerId, role, name, send });

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
