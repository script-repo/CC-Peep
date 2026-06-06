# Architecture

The **audio agents** project streams audio bidirectionally between a **Windows
virtual machine** and a **browser**.

**Transport decision:** **WebSocket for presence + signaling**, **WebRTC for the
audio media**. The web server is a *signaling/presence broker* — it does **not**
carry audio. Peers exchange WebRTC offers/answers/ICE candidates over WebSocket, then
audio flows peer-to-peer over WebRTC.

See [background-conversation.md](./background-conversation.md) for the motivating
discussion.

## Components

| Component         | Folder        | Responsibility                                                                  | Default stack          |
| ----------------- | ------------- | ------------------------------------------------------------------------------- | ---------------------- |
| **VM agent**      | `vm-agent/`   | Capture mic + system audio on the Windows VM; WebRTC peer; WS signaling client  | C# / .NET + NAudio     |
| **Signaling srv** | `server/`     | Track presence; broker WebRTC offers/answers/ICE between peers (no audio path)  | Node.js + `ws`         |
| **Web client**    | `web-client/` | Browser UI; WebRTC peer for audio in/out; WS signaling client                   | Vanilla JS + Web Audio |
| **Shared**        | `shared/`     | Presence + signaling message schema shared across components                    | JS message contracts   |

> Stack choices are sensible defaults for this lab demo and can be swapped (e.g. a
> Python relay, or WebRTC instead of raw WebSockets).

## Data flow

```
                        ┌───────────────────────────┐
                        │  Signaling/presence server │
                        │  server/  (WebSocket)      │
                        └──────────┬─────────────────┘
       WS: hello / presence / signal (SDP + ICE)
        ┌──────────────────────────┴──────────────────────────┐
        │                                                      │
┌───────▼─────────┐                                  ┌─────────▼────────┐
│  VM agent       │                                  │  Web client      │
│  vm-agent/      │                                  │  web-client/     │
│  NAudio capture │                                  │  getUserMedia    │
│  + playback     │                                  │  + Web Audio API │
└───────┬─────────┘                                  └─────────┬────────┘
        │                  WebRTC audio (P2P)                  │
        └──────────────────────────────────────────────────────┘
                       audio.out (VM→UI) / audio.in (UI→VM)
```

- **Signaling (over WebSocket):** both peers connect to `server/`, announce presence,
  and exchange WebRTC `offer` / `answer` / ICE `candidate` messages. The server only
  routes these control messages.
- **Audio (over WebRTC, peer-to-peer):**
  - **Output (VM → browser):** VM agent publishes a WebRTC audio track (system/loopback
    captured via NAudio) → browser plays it with the Web Audio API.
  - **Input (browser → VM):** browser publishes its mic track (`getUserMedia`) → VM
    agent plays it into the VM's audio device.

## Channels

Two logical audio channels multiplexed over the relay (per the conversation —
"one channel for input, one channel for audio output"):

- `audio.out` — VM system audio destined for the browser speakers.
- `audio.in`  — Browser microphone destined for the VM.

These map to WebRTC audio tracks negotiated during signaling. The shared message
schema in `shared/` defines the presence + signaling envelopes.

## Open decisions

- **Codec:** Opus is effectively the WebRTC default and is recommended.
- **VM audio source:** WASAPI loopback (system output) vs. a virtual audio cable.
- **VM WebRTC stack:** which library the .NET agent uses to be a WebRTC peer
  (e.g. SIPSorcery, Pion via a sidecar, or a GStreamer `webrtcbin` bridge).
- **ICE / NAT traversal:** STUN/TURN configuration (lab-local may not need TURN).
- **Session/auth model:** how the browser and VM agent pair to the same session.
