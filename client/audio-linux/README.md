# audio-linux — Linux audio bridge

The Linux counterpart of `client/audio-ps` (the Windows NAudio bridge). It connects to
the portal over the **WebSocket relay** and uses **ffmpeg** with **PulseAudio/PipeWire**
to move audio in and out of the machine. Same wire format as every other peer: an
`audio-format` control message, then raw little-endian 16-bit mono PCM as binary frames.

```
ffmpeg (pulse capture) ─► mono 16-bit @16kHz ─► WS binary ─► portal relay ─► browser
browser mic ─► WS binary ─► portal relay ─► ffmpeg (pulse playback) ─► Linux sink
```

## Requirements

- Node.js >= 18 and `ffmpeg` on PATH.
- PulseAudio or PipeWire (with `pactl` / the pulse shim).

```bash
# Debian/Ubuntu
sudo apt-get install -y nodejs npm ffmpeg pulseaudio-utils
# Fedora/RHEL
sudo dnf install -y nodejs ffmpeg pulseaudio-utils
```

## Install & run

```bash
cd client/audio-linux
npm install
node audio-bridge.mjs --portal wss://10.42.156.41:8080/ws --session lab
```

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--portal` / `CCPEEP_PORTAL` | `ws://localhost:8080/ws` | portal WS/WSS URL |
| `--session` / `CCPEEP_SESSION` | `lab` | session id (match the browser) |
| `--name` / `CCPEEP_NAME` | `linux-<hostname>` | display name |
| `--direction` / `CCPEEP_DIRECTION` | `both` | `out` (Linux→browser), `in` (browser→Linux) |
| `--rate` / `CCPEEP_RATE` | `16000` | relay sample rate (mono, 16-bit) |
| `--capture-source` / `CCPEEP_CAPTURE_SOURCE` | `@DEFAULT_MONITOR@` | Pulse source for `audio.out` |
| `--playback-sink` / `CCPEEP_PLAYBACK_SINK` | `@DEFAULT_SINK@` | Pulse sink for `audio.in` |

`@DEFAULT_MONITOR@` captures whatever is playing on the default sink. For a self-signed
`wss://` portal the bridge accepts the cert unless `CCPEEP_TLS_STRICT=1`.

## Headless? Create virtual devices

A server with no sound card has no Pulse source/sink. Create virtual ones (mirrors the
Windows Scream + VB-CABLE setup):

```bash
client/scripts/setup-linux-audio.sh
```

This adds `ccpeep_out` (a sink apps output to), `ccpeep_in` (where the bridge plays the
browser mic), and `ccpeep_mic` (a virtual microphone apps read). Then run the bridge
echo-free in full duplex:

```bash
node audio-bridge.mjs --portal wss://HOST:8080/ws --session lab \
  --capture-source ccpeep_out.monitor --playback-sink ccpeep_in
```

In your Linux app: set **output → CCPeep-Out** and **microphone → CCPeep-Mic**. Result:
browser mic → `ccpeep_in` → `ccpeep_mic` → app's mic; app audio → `ccpeep_out` → loopback
→ browser. Remove the devices with `setup-linux-audio.sh --unload`.

## Quick self-test (hear your own voice)

```bash
node audio-bridge.mjs --portal wss://HOST:8080/ws --session lab \
  --capture-source ccpeep_in.monitor --playback-sink ccpeep_in
```

Open the portal in a browser, join the same session, start the mic, and speak — your
voice loops back through the Linux box, proving the full path.
