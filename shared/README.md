# shared — presence + signaling protocol

Definitions shared across the **vm-agent**, **server**, and **web-client** so they
agree on the WebSocket control messages used for presence and WebRTC signaling.

> The WebSocket carries **control messages only**. Audio media flows over **WebRTC**
> once signaling completes.

## [`protocol.js`](./protocol.js)

Dependency-free ESM module (importable by Node and the browser) defining:

- `Role` — `vm-agent` | `web-client`
- `MessageType` — `hello` · `welcome` · `presence` · `signal` · `bye` · `error`
- `SignalKind` — `offer` · `answer` · `candidate`
- `AudioChannel` — `audio.out` (VM→UI) · `audio.in` (UI→VM)
- Message builder helpers and `DEFAULT_SESSION`

## Message flow

```
client → server : hello   { sessionId, role, name }
server → client : welcome { peerId, sessionId }
server → all    : presence{ peers: [...] }
client ↔ client : signal  { to, from, kind: offer|answer|candidate, data }  (relayed by server)
server → all    : bye     { peerId }
```

