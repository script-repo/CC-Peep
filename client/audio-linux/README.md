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
| `--capture-source` / `CCPEEP_CAPTURE_SOURCE` | `@DEFAULT_MONITOR@` | source for `audio.out` |
| `--playback-sink` / `CCPEEP_PLAYBACK_SINK` | `@DEFAULT_SINK@` | sink for `audio.in` |
| `--capture-format` / `CCPEEP_CAPTURE_FORMAT` | `pulse` | ffmpeg input backend (`pulse` or `alsa`) |
| `--playback-format` / `CCPEEP_PLAYBACK_FORMAT` | `pulse` | ffmpeg output backend (`pulse` or `alsa`) |
| `--loopback` / `CCPEEP_LOOPBACK=1` | off | echo `audio.in` back as `audio.out` (no devices) |

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

## Testing on a headless VM (no sound card)

A headless server usually has **no PulseAudio/PipeWire daemon and no sink**, so the
defaults fail with `@DEFAULT_MONITOR@: No such process` / `Cannot connect context:
Access denied`. Test in this order.

### 1. Echo mode — proves the path with zero audio drivers

```bash
node audio-bridge.mjs --portal wss://HOST:8080/ws --session lab --loopback
```

The client returns every `audio.in` frame straight back as `audio.out` — no ffmpeg, no
devices. In the browser: join the same session, **Start microphone & audio**, and speak.
You should hear yourself (browser → portal → client → portal → browser). If this works,
the relay and browser audio are correct and only the OS audio backend remains.

### 2. Real devices via ALSA loopback (no daemon needed)

Load the kernel loopback module, then use the `alsa` backend. Audio written to
`hw:Loopback,0,N` is readable from `hw:Loopback,1,N`.

```bash
sudo modprobe snd-aloop
# persist across reboots (optional):
echo snd-aloop | sudo tee /etc/modules-load.d/snd-aloop.conf

# self-test: play browser mic into Loopback,0,0 and capture it back from Loopback,1,0
node audio-bridge.mjs --portal wss://HOST:8080/ws --session lab \
  --capture-format alsa --capture-source hw:Loopback,1,0 \
  --playback-format alsa --playback-sink hw:Loopback,0,0
```

Speak in the browser — you hear yourself, now routed through a real kernel audio device.
For app integration: an app plays to `hw:Loopback,0,1` (you capture `hw:Loopback,1,1`
for `audio.out`) and reads `hw:Loopback,1,0` as its mic (you play to `hw:Loopback,0,0`).

### 3. Real devices via PulseAudio null sinks

If you prefer Pulse/PipeWire, run `client/scripts/setup-linux-audio.sh` (needs a running
user Pulse/PipeWire session) and use `--capture-source ccpeep_out.monitor
--playback-sink ccpeep_in` as shown above.
