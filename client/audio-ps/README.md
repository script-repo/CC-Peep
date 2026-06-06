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
| `-PlaybackDevice` | default endpoint   | render device name to play `audio.in` into (e.g. `CABLE Input`) |
| `-CaptureDevice`  | default endpoint   | render device name to loopback for `audio.out` (e.g. `Scream`)  |

`-PlaybackDevice`/`-CaptureDevice` match on a substring of the device name, so the bridge
can target specific endpoints instead of the system default.

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

## No audio device? (common on a headless server)

Windows Server has **Windows Audio disabled** by default and many VMs (Nutanix, etc.)
have **no audio endpoint at all**. WASAPI loopback needs a playback (render) device to
capture, so without one the bridge stays connected for presence but logs that audio is
disabled (HRESULT `0x80070490` "Element not found" if you see it raw). Give the VM a
device by any of:

- **RDP with audio redirection** — connect via Remote Desktop, and under *Local
  Resources → Remote audio → Settings* choose **Play on this computer**. That adds a
  render endpoint in the session; loopback then captures whatever plays in the VM.
- **A virtual audio device/driver** — run the bundled helper from an **Administrator**
  PowerShell to install [Scream](https://github.com/duncanthrax/scream) unattended:

  ```powershell
  powershell -ExecutionPolicy Bypass -File client\scripts\install-virtual-audio.ps1
  ```

  Then open `mmsys.cpl` and set **Scream** as the default playback device (reboot once
  if the device doesn't appear). Apps in the VM output to it and the bridge captures it.

The bridge tries to start the `Audiosrv` service automatically (run as Administrator),
but a device must still exist.

## Make the browser mic a microphone for VM apps (full duplex)

Scream only provides a *playback* device, so apps in the VM can't read the browser mic
as an input. For that, install **VB-CABLE**, which exposes a linked pair: `CABLE Input`
(playback) and `CABLE Output` (a *recording* device / virtual mic).

```powershell
powershell -ExecutionPolicy Bypass -File client\scripts\install-virtual-audio.ps1 -Driver VBCable
```

Then wire it up:

- In the VM app, set its **microphone** to `CABLE Output (VB-Audio Virtual Cable)`.
- Set the VM app's **speaker** to **Scream** (so its output can be looped to the browser).
- Run the bridge targeting both devices (no echo, since the loopback source differs from
  the mic-injection sink):

```powershell
audio-bridge.ps1 -Portal wss://HOST:8080/ws -Session lab -PlaybackDevice "CABLE Input" -CaptureDevice Scream
```

Result: browser mic → `CABLE Input` → `CABLE Output` → VM app's mic; VM app audio →
Scream → loopback → browser.
