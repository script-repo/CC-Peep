# server — presence + WebRTC signaling

Brokers **presence** and **WebRTC signaling** between the **VM agent** and the
**web client** over WebSocket. It does **not** carry audio — audio flows peer-to-peer
over WebRTC once signaling completes.

## Endpoints

- `GET /health` — JSON liveness probe (`{ status, sessions }`).
- `WS  /ws` — signaling channel speaking the [shared protocol](../shared/protocol.js).

## Message flow

```
client → server : hello   { sessionId, role, name }
server → client : welcome { peerId, sessionId }
server → all    : presence{ peers: [...] }
client ↔ client : signal  { to, from, kind: offer|answer|candidate, data }
server → all    : bye     { peerId }
```

## Run

```bash
cd server
npm install
npm start        # or: npm run dev   (auto-restart on change)
```

Configurable via env: `PORT` (default `8080`), `HOST` (default `0.0.0.0`).

## Layout

- `src/index.js` — HTTP + WebSocket wiring, lifecycle.
- `src/signaling.js` — `SignalingHub`: session/peer tracking and message routing.

## Stack

- Node.js (ESM) + [`ws`](https://github.com/websockets/ws)
