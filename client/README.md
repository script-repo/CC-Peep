# client — Windows VM audio agent

Runs **inside the Windows virtual machine**. Connects to the **portal** (Linux) for
presence + WebRTC signaling, and (when audio is wired up) bridges the VM's audio
devices to the web client.

## Single-line install (Windows PowerShell)

Run from an elevated PowerShell on the Windows VM. The `[Net.ServicePointManager]`
line forces TLS 1.2 **before** the download; older Windows (Server 2012 R2) defaults
to TLS 1.0, which GitHub rejects (*"Could not create SSL/TLS secure channel"*):

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; iex (irm https://raw.githubusercontent.com/script-repo/CC-Peep/main/install.ps1)
```

Set the portal host first (otherwise the installer prompts for it):

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $env:CCPEEP_PORTAL = "ws://YOUR-LINUX-HOST:8080/ws"; iex (irm https://raw.githubusercontent.com/script-repo/CC-Peep/main/install.ps1)
```

The installer ensures Node.js is present (via `winget`), clones the repo to
`%LOCALAPPDATA%\CC-Peep`, runs `npm install`, writes `client\config.json`, and offers
to register a **logon Scheduled Task** so the agent auto-starts and restarts on
failure. Skip the prompt with `$env:CCPEEP_SERVICE = "1"` (task) or `"0"` (run once).

### Auto-start as a background task

```powershell
# register (also done by the installer)
powershell -ExecutionPolicy Bypass -File client\scripts\register-task.ps1
# remove
powershell -ExecutionPolicy Bypass -File client\scripts\unregister-task.ps1
```

The task runs in the interactive logon session so WASAPI audio capture can reach the
VM's audio devices.

## Run manually

```powershell
cd client
npm install
node src/agent.js --portal ws://YOUR-LINUX-HOST:8080/ws --session lab --name vm-1
```

Configuration resolves in this order: CLI flags → env vars (`CCPEEP_PORTAL`,
`CCPEEP_SESSION`, `CCPEEP_NAME`) → `client/config.json` → defaults.

## Layout

- `src/agent.js` — signaling/presence client (Node): connects, announces the
  `vm-agent` role, tracks presence, auto-reconnects, receives WebRTC signaling.
- `audio/` — **NAudio (WASAPI) audio engine** (.NET): real system-loopback and mic
  capture + playback. See [`audio/README.md`](./audio/README.md).
- `scripts/` — register/unregister the background Scheduled Task.

## Status

- **Implemented:** signaling/presence client; WASAPI capture + playback engine
  (runnable standalone); background auto-start.
- **Remaining glue:** a WebRTC peer (e.g.
  [SIPSorcery](https://github.com/sipsorcery-org/sipsorcery)) bridging the audio
  engine's PCM frames to the `audio.out` / `audio.in` tracks, driven by the signaling
  hooks marked `TODO` in [`src/agent.js`](./src/agent.js).
