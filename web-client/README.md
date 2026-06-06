# web-client — browser client

The web-based interface that acts as the **client** for the audio stream.

## Role

- Connect to the relay [`../server/`](../server/) over WebSocket.
- **Playback:** receive `audio.out` frames from the VM and play them via the
  **Web Audio API**.
- **Capture:** grab the microphone via **`getUserMedia`**, encode, and send `audio.in`
  frames back to the VM.

## Planned stack

- Vanilla JS + Web Audio API + `getUserMedia` (WebRTC optional)

## Not built yet

This folder is a placeholder. UI and audio pipeline implementation comes next.
