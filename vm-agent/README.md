# vm-agent — Windows VM audio agent

Runs **inside the Windows virtual machine**. Captures and plays audio, bridging the
VM's audio devices to the relay over WebSocket.

## Role

- **Capture:** grab system/loopback output (and/or mic) using **WASAPI** via
  [**NAudio**](https://github.com/naudio/NAudio).
- **Encode:** compress frames (Opus recommended) and send `audio.out` to the relay.
- **Playback:** receive `audio.in` frames from the relay and play them into the VM's
  audio device.

## Planned stack

- C# / .NET + NAudio (WASAPI loopback for system audio)

## Not built yet

This folder is a placeholder. Capture/playback and WebSocket client implementation
comes next.
