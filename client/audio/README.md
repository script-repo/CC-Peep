# audio — NAudio (WASAPI) audio engine

The Windows-side audio capture/playback for the VM client, built on
[NAudio](https://github.com/naudio/NAudio). This is the **audio engine**; the
[Node agent](../src/agent.js) handles **presence + WebRTC signaling**. The remaining
glue is a WebRTC peer (e.g. [SIPSorcery](https://github.com/sipsorcery-org/sipsorcery))
that moves PCM between this engine and the browser.

## What works today

Real WASAPI capture and playback, runnable standalone:

```powershell
# Requires the .NET SDK (8.0+). install.ps1 can fetch it with: winget install Microsoft.DotNet.SDK.8
cd client\audio
dotnet run -- list                       # enumerate render + capture devices
dotnet run -- loopback 5 system.wav      # record system output (audio.out source)
dotnet run -- mic 5 mic.wav              # record the microphone
dotnet run -- play system.wav            # play a WAV back
dotnet run -- monitor 10                 # live: system audio -> speakers (round-trip)
```

## Integration surface

| Class            | Role                                                         | Maps to     |
| ---------------- | ------------------------------------------------------------ | ----------- |
| `AudioCapture`   | WASAPI loopback (system) or mic → raw PCM via `FrameAvailable` | `audio.out` |
| `AudioPlayback`  | buffers decoded PCM and plays it into the render device       | `audio.in`  |

Wiring it to the network (the part still marked `TODO`):

```
AudioCapture.FrameAvailable ─► Opus encode ─► WebRTC audio.out track ─► browser
browser mic ─► WebRTC audio.in track ─► Opus decode ─► AudioPlayback.Enqueue
```

The WebRTC peer's offer/answer/ICE messages travel over the existing signaling path —
see the `SignalKind` hooks in [`../src/agent.js`](../src/agent.js). A future step folds
this engine and a SIPSorcery peer into the client so the agent both signals *and*
carries audio.

## Notes

- Capture format is the device mix format (commonly 32-bit IEEE float). Resample to
  48 kHz mono and encode with Opus before sending over WebRTC.
- WASAPI needs an interactive session, which is why the client runs as a logon
  Scheduled Task (see [`../scripts/register-task.ps1`](../scripts/register-task.ps1))
  rather than a session-0 service.
