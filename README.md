# audio agents

Stream audio **into and out of a Windows virtual machine over an API**. A Linux
**portal** brokers presence + WebRTC signaling and serves the browser UI; a Windows
**client** runs inside the VM. Audio flows peer-to-peer over WebRTC.

```
VM (client) ──┐                              ┌── browser (web UI)
              │  WebSocket: presence/signal  │
              └────────►  PORTAL (Linux)  ◄───┘
                 WebRTC audio (P2P): VM ⇄ browser
```

## Two code trees

| Tree        | Runs on     | Contents                                                            |
| ----------- | ----------- | ------------------------------------------------------------------- |
| `portal/`   | **Linux**   | `server/` signaling + static host, `web-client/` browser UI         |
| `client/`   | **Windows** | VM audio agent (signaling client; audio capture/playback to follow) |
| `shared/`   | both        | `protocol.js` — presence + signaling message contracts              |
| `docs/`     | —           | background conversation and architecture notes                      |

## Single-line install

**Windows VM (client):** run in PowerShell. Set the portal endpoint first.

```powershell
$env:CCPEEP_PORTAL = "ws://YOUR-LINUX-HOST:8080/ws"; powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/script-repo/CC-Peep/main/install.ps1 | iex"
```

**Linux host (portal):**

```bash
curl -fsSL https://raw.githubusercontent.com/script-repo/CC-Peep/main/install.sh | bash
```

The installers ensure Node.js (+ git), fetch the repo, install dependencies, and
start the component. The portal serves the web client at `http://<host>:8080/`.

## Manual run

```bash
# Portal (Linux)
cd portal/server && npm install && npm start        # http://localhost:8080

# Client (Windows)
cd client && npm install
node src/agent.js --portal ws://YOUR-LINUX-HOST:8080/ws --session lab --name vm-1
```

Then open the portal URL in a browser, click **Connect**, and **Start microphone &
audio**. The browser and any peer in the same `session` negotiate a WebRTC audio link.

## Status

- **Implemented:** portal signaling server, shared protocol, browser web client
  (presence + WebRTC mic/playback), Windows client signaling agent + installers.
- **Planned:** VM-side audio capture/playback (WASAPI via NAudio + a WebRTC peer).
  See [`docs/architecture.md`](docs/architecture.md) and the `TODO`s in
  [`client/src/agent.js`](client/src/agent.js).

## Start here

1. [`docs/architecture.md`](docs/architecture.md) — components, data flow, decisions.
2. [`docs/background-conversation.md`](docs/background-conversation.md) — the framing.
