# audio-ps — NAudio audio bridge (Windows Server 2012 R2 friendly)

Streams the VM's audio to/from the portal over the **WebSocket relay** — no WebRTC,
no compiler, no SDK. The script downloads `NAudio.dll` and compiles a small C# audio
engine at runtime with `Add-Type` (the C# compiler ships with the .NET Framework, so
this works on a default Windows Server 2012 R2 / Windows PowerShell 5.1).

## Why this instead of the .NET/WebRTC design

Default Server 2012 R2 has only .NET Framework 4.5.x and no build tools, and modern
.NET (8) requires Server 2016+. NAudio 1.x runs on .NET Framework 4.x and can be loaded
by PowerShell directly, so this is the path that actually runs on the target.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File audio-bridge.ps1 -Portal ws://10.42.156.41:8080/ws
# HTTPS portal:
powershell -ExecutionPolicy Bypass -File audio-bridge.ps1 -Portal wss://10.42.156.41:8080/ws
```

Or via the installer: `-$env:CCPEEP_AUDIO = "1"` before running `install.ps1`.

| Param         | Default                | Meaning                                   |
| ------------- | ---------------------- | ----------------------------------------- |
| `-Portal`     | `$CCPEEP_PORTAL`       | portal WS/WSS URL                         |
| `-Session`    | `lab`                  | session id (must match the browser)       |
| `-Name`       | `vm-<COMPUTERNAME>`    | display name                              |
| `-Direction`  | `both`                 | `out` (VM→browser), `in` (browser→VM)     |
| `-SampleRate` | `16000`                | relay PCM sample rate (mono, 16-bit)      |

## How it works

```
WASAPI loopback (NAudio) ─► mono 16-bit @16kHz ─► WSS binary frames ─► portal relay ─► browser (Web Audio)
browser mic ─► WSS binary frames ─► portal relay ─► NAudio WaveOut ─► VM speakers
```

The engine sends an `audio-format` control message, then raw little-endian 16-bit PCM
as binary frames. For a self-signed `wss://` portal the bridge accepts the cert
(it's a lab default).

## Requirements

- Windows PowerShell 5.1 (Windows Server 2012 R2+); .NET Framework 4.5+.
- Outbound access to nuget.org once (to fetch `NAudio.dll`, cached in
  `%LOCALAPPDATA%\cc-peep-naudio`). Pre-seed it with `-NAudioDll <path>` for offline.
- `WasapiLoopbackCapture` captures the **default render device** output.
