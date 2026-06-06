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

### HTTPS (required for browser microphone)

Browsers only expose microphone capture (`getUserMedia`) in a **secure context**
(HTTPS or `localhost`). To serve the portal over HTTPS/WSS with a self-signed cert:

```bash
CCPEEP_TLS=1 curl -fsSL https://raw.githubusercontent.com/script-repo/CC-Peep/main/install.sh | bash
# or, on an existing checkout:
bash portal/scripts/gen-cert.sh <portal-ip>   # writes portal/certs/{cert,key}.pem
node portal/server/src/index.js                # auto-detects the cert -> https/wss
```

Then use `https://<host>:8080/` in the browser (accept the self-signed warning) and
`wss://<host>:8080/ws` for the client. The Windows agent accepts the self-signed cert
by default; set `CCPEEP_TLS_STRICT=1` to enforce verification. Provide your own cert
with `CCPEEP_TLS_CERT` / `CCPEEP_TLS_KEY`.

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

## Audio

Audio uses a **WebSocket relay** (not WebRTC): peers send an `audio-format` control
message, then stream raw 16-bit PCM as binary frames that the portal forwards to the
other peers. This runs on a default **Windows Server 2012 R2** (no SDK/compiler) — the
Windows side downloads `NAudio.dll` and compiles a tiny C# engine at runtime.

```powershell
# On the VM (after install): stream system audio out + mic in
powershell -ExecutionPolicy Bypass -File client\audio-ps\audio-bridge.ps1 -Portal wss://<host>:8080/ws
```

In the browser, open the portal (HTTPS for mic — see above), Connect, then
**Start microphone & audio**: you'll hear the VM's system audio and your mic streams to
the VM. See [`client/audio-ps/README.md`](client/audio-ps/README.md).

## Status

- **Implemented:** portal (signaling + presence + audio relay, optional HTTPS/WSS),
  shared protocol, browser client (presence + PCM playback/mic over the relay), Windows
  signaling agent, Windows NAudio audio bridge, and single-line installers.
- **Notes:** the original design targeted WebRTC; on default Server 2012 R2 that isn't
  practical, so audio uses the WebSocket relay. A `client/audio/` .NET NAudio engine and
  the `client/src/agent.js` WebRTC hooks remain for newer Windows targets.

## Start here

1. [`docs/architecture.md`](docs/architecture.md) — components, data flow, decisions.
2. [`docs/background-conversation.md`](docs/background-conversation.md) — the framing.
