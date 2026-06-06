# CC-Peep audio bridge for Windows Server 2012 R2 (default install).
#
# Streams VM audio to/from the portal over the WebSocket relay, with no compiler or
# SDK required: it downloads NAudio.dll and compiles a tiny C# audio engine at runtime
# via Add-Type (csc.exe ships with the .NET Framework).
#
#   powershell -ExecutionPolicy Bypass -File audio-bridge.ps1 -Portal wss://HOST:8080/ws
#
# Config (params override env): -Portal/$CCPEEP_PORTAL, -Session/$CCPEEP_SESSION,
# -Name/$CCPEEP_NAME, -Direction both|out|in, -SampleRate.
#
#   out  = VM system audio  -> browser   (audio.out)
#   in   = browser mic       -> VM        (audio.in)
#   both = full duplex (default)

param(
  [string]$Portal     = $env:CCPEEP_PORTAL,
  [string]$Session    = $(if ($env:CCPEEP_SESSION) { $env:CCPEEP_SESSION } else { "lab" }),
  [string]$Name       = $(if ($env:CCPEEP_NAME) { $env:CCPEEP_NAME } else { "vm-$env:COMPUTERNAME" }),
  [ValidateSet("both", "out", "in")] [string]$Direction = "both",
  [int]$SampleRate    = 16000,
  # Render endpoint to play the browser mic INTO (audio.in). With VB-CABLE installed,
  # use "CABLE Input" so VM apps can read it back as a mic on "CABLE Output".
  [string]$PlaybackDevice = $env:CCPEEP_PLAYBACK_DEVICE,
  # Render endpoint to loopback-capture for audio.out. Point VM apps' speaker here
  # (e.g. "Scream") so you can hear them without capturing the injected mic (no echo).
  [string]$CaptureDevice  = $env:CCPEEP_CAPTURE_DEVICE,
  [string]$NAudioDll  = $env:CCPEEP_NAUDIO_DLL,
  [string]$NAudioVersion = "1.10.0"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Portal)) { $Portal = "ws://localhost:8080/ws" }

[Net.ServicePointManager]::SecurityProtocol =
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

# Extract a zip (PS4-safe): prefer .NET ZipFile, else Shell COM with a wait.
function Expand-ZipSafe($zip, $dest) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
    return
  } catch {}
  if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
  $shell = New-Object -ComObject Shell.Application
  $items = $shell.NameSpace($zip).Items()
  $expected = $items.Count
  $shell.NameSpace($dest).CopyHere($items, 0x14)
  $waited = 0
  while (((Get-ChildItem $dest -Force | Measure-Object).Count -lt $expected) -and ($waited -lt 120)) {
    Start-Sleep -Milliseconds 500; $waited++
  }
}

function Resolve-NAudio {
  if ($NAudioDll -and (Test-Path $NAudioDll)) { return (Resolve-Path $NAudioDll).Path }
  $cache = Join-Path $env:LOCALAPPDATA "cc-peep-naudio"
  $dll = Join-Path $cache "NAudio.dll"
  if (Test-Path $dll) { return $dll }

  Write-Step "Downloading NAudio $NAudioVersion from nuget.org..."
  if (-not (Test-Path $cache)) { New-Item -ItemType Directory -Path $cache | Out-Null }
  $nupkg = Join-Path $env:TEMP "naudio-$NAudioVersion.zip"
  Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/NAudio/$NAudioVersion" -OutFile $nupkg
  $extract = Join-Path $env:TEMP "naudio-extract"
  Expand-ZipSafe $nupkg $extract

  # Prefer a .NET Framework build (net35/net40/net4x) over netstandard/netcore.
  $candidates = Get-ChildItem -Path (Join-Path $extract "lib") -Recurse -Filter "NAudio.dll" -ErrorAction SilentlyContinue
  $pick = $candidates | Where-Object { $_.DirectoryName -match "net(35|40|4\d?\d?)" } | Select-Object -First 1
  if (-not $pick) { $pick = $candidates | Select-Object -First 1 }
  if (-not $pick) { throw "NAudio.dll not found inside the downloaded package." }
  Copy-Item $pick.FullName $dll -Force
  Remove-Item -Force $nupkg -ErrorAction SilentlyContinue
  Write-Ok "NAudio.dll -> $dll (from $($pick.Directory.Name))"
  return $dll
}

$naudio = Resolve-NAudio
[Reflection.Assembly]::LoadFrom($naudio) | Out-Null

# Windows Audio is disabled by default on Server. Try to enable it (needs admin); a
# device must still exist (RDP remote audio or a virtual cable) for capture/playback.
try {
  $svc = Get-Service Audiosrv -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne "Running") {
    Write-Step "Starting Windows Audio service (Audiosrv)..."
    Set-Service Audiosrv -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service Audiosrv -ErrorAction SilentlyContinue
  }
} catch { Write-Host "    (could not start Audiosrv - run as Administrator if audio is missing)" -ForegroundColor Yellow }

$cs = @'
using System;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NAudio.Wave;
using NAudio.CoreAudioApi;

public class CcPeepAudioBridge
{
    private readonly string _portal, _session, _name, _direction;
    private readonly string _playbackDevice, _captureDevice;
    private readonly int _outRate;
    private ClientWebSocket _ws;
    private readonly CancellationTokenSource _cts = new CancellationTokenSource();
    private readonly object _sendLock = new object();
    private WasapiLoopbackCapture _capture;
    private WaveOutEvent _output;
    private BufferedWaveProvider _playBuffer;

    public CcPeepAudioBridge(string portal, string session, string name, string direction, int outRate, string playbackDevice, string captureDevice)
    {
        _portal = portal; _session = session; _name = name; _direction = direction; _outRate = outRate;
        _playbackDevice = playbackDevice; _captureDevice = captureDevice;
    }

    private static MMDevice FindRender(string nameContains)
    {
        if (string.IsNullOrEmpty(nameContains)) return null;
        var en = new MMDeviceEnumerator();
        foreach (var d in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            if (d.FriendlyName.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0) return d;
        return null;
    }

    // Match a legacy waveOut device index by name (WaveOutEvent auto-resamples, so a
    // 16k mono feed works into any endpoint without MediaFoundation).
    private static int FindWaveOut(string nameContains)
    {
        if (string.IsNullOrEmpty(nameContains)) return -1;
        for (int n = 0; n < WaveOut.DeviceCount; n++)
            if (WaveOut.GetCapabilities(n).ProductName.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0) return n;
        return -1;
    }

    public void Run()
    {
        ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
        _ws = new ClientWebSocket();
        Log("connecting to " + _portal);
        _ws.ConnectAsync(new Uri(_portal), _cts.Token).GetAwaiter().GetResult();
        Log("connected; announcing presence as vm-agent");
        SendText("{\"type\":\"hello\",\"sessionId\":\"" + Esc(_session) + "\",\"role\":\"vm-agent\",\"name\":\"" + Esc(_name) + "\"}");

        bool capturing = false, playing = false;
        if (_direction != "in") capturing = TryStartCapture();
        if (_direction != "out") playing = TryStartPlayback();

        if (!capturing && !playing)
        {
            Log("No usable audio device - staying connected for presence only.");
            Log("This VM has no audio render/capture endpoint. Fixes:");
            Log("  * Connect via RDP with 'Remote audio' = 'Play on this computer' (adds a device), or");
            Log("  * install a virtual audio device (e.g. VB-CABLE / Scream), then re-run.");
        }

        ReceiveLoop().GetAwaiter().GetResult();
        Log("disconnected");
    }

    private static bool HasDevice(DataFlow flow)
    {
        try
        {
            using (var en = new MMDeviceEnumerator())
                return en.EnumerateAudioEndPoints(flow, DeviceState.Active).Count > 0;
        }
        catch { return false; }
    }

    private bool TryStartCapture()
    {
        if (!HasDevice(DataFlow.Render))
        {
            Log("audio.out disabled: no active playback (render) device to capture (WASAPI loopback).");
            return false;
        }
        try { StartCapture(); return true; }
        catch (Exception ex) { Log("audio.out capture failed: " + ex.Message); return false; }
    }

    private bool TryStartPlayback()
    {
        if (!HasDevice(DataFlow.Render))
        {
            Log("audio.in disabled: no active playback (render) device to play into.");
            return false;
        }
        try { StartPlayback(); return true; }
        catch (Exception ex) { Log("audio.in playback failed: " + ex.Message); return false; }
    }

    private void StartCapture()
    {
        MMDevice src = FindRender(_captureDevice);
        if (src != null) { _capture = new WasapiLoopbackCapture(src); Log("audio.out loopback source: " + src.FriendlyName); }
        else
        {
            if (!string.IsNullOrEmpty(_captureDevice)) Log("capture device '" + _captureDevice + "' not found; using default render endpoint.");
            _capture = new WasapiLoopbackCapture();
        }
        var f = _capture.WaveFormat;
        Log("capturing system audio: " + f.SampleRate + "Hz " + f.Channels + "ch " + f.BitsPerSample + "-bit -> " + _outRate + "Hz mono 16-bit");
        SendText("{\"type\":\"audio-format\",\"channel\":\"audio.out\",\"sampleRate\":" + _outRate + ",\"channels\":1,\"bits\":16}");
        _capture.DataAvailable += (s, e) =>
        {
            try
            {
                byte[] pcm = ToMono16(e.Buffer, e.BytesRecorded, f, _outRate);
                if (pcm.Length > 0) SendBinary(pcm);
            }
            catch { }
        };
        _capture.StartRecording();
    }

    private void StartPlayback()
    {
        var fmt = new WaveFormat(_outRate, 16, 1);
        _playBuffer = new BufferedWaveProvider(fmt);
        _playBuffer.BufferDuration = TimeSpan.FromSeconds(5);
        _playBuffer.DiscardOnBufferOverflow = true;
        _output = new WaveOutEvent();
        int dev = FindWaveOut(_playbackDevice);
        if (dev >= 0) { _output.DeviceNumber = dev; Log("audio.in playback target: " + WaveOut.GetCapabilities(dev).ProductName); }
        else if (!string.IsNullOrEmpty(_playbackDevice)) Log("playback device '" + _playbackDevice + "' not found; using default output endpoint.");
        _output.Init(_playBuffer);
        _output.Play();
        Log("playback ready: " + _outRate + "Hz mono 16-bit (audio.in)");
    }

    // Convert an interleaved IEEE-float (or 16-bit) buffer to mono 16-bit PCM,
    // decimated to outRate by nearest-sample selection.
    private static byte[] ToMono16(byte[] buf, int count, WaveFormat f, int outRate)
    {
        int inCh = f.Channels;
        bool isFloat = f.Encoding == WaveFormatEncoding.IeeeFloat || f.BitsPerSample == 32;
        int bytesPerSample = f.BitsPerSample / 8;
        int frameSize = bytesPerSample * inCh;
        if (frameSize == 0) return new byte[0];
        int frames = count / frameSize;
        double ratio = (double)f.SampleRate / outRate;
        if (ratio < 1) ratio = 1;
        int outFrames = (int)(frames / ratio);
        var outBytes = new byte[outFrames * 2];
        int o = 0;
        for (int k = 0; k < outFrames; k++)
        {
            int i = (int)(k * ratio);
            float mono = 0f;
            for (int c = 0; c < inCh; c++)
            {
                int off = i * frameSize + c * bytesPerSample;
                if (off + bytesPerSample > count) break;
                if (isFloat) mono += BitConverter.ToSingle(buf, off);
                else mono += BitConverter.ToInt16(buf, off) / 32768f;
            }
            mono /= inCh;
            if (mono > 1f) mono = 1f; else if (mono < -1f) mono = -1f;
            short s = (short)(mono * 32767f);
            outBytes[o++] = (byte)(s & 0xff);
            outBytes[o++] = (byte)((s >> 8) & 0xff);
        }
        return outBytes;
    }

    private async Task ReceiveLoop()
    {
        var buf = new byte[32768];
        while (_ws.State == WebSocketState.Open)
        {
            using (var ms = new MemoryStream())
            {
                WebSocketReceiveResult r;
                do
                {
                    r = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), _cts.Token);
                    if (r.MessageType == WebSocketMessageType.Close)
                    {
                        await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
                        return;
                    }
                    ms.Write(buf, 0, r.Count);
                } while (!r.EndOfMessage);

                if (r.MessageType == WebSocketMessageType.Binary && _playBuffer != null)
                {
                    byte[] pcm = ms.ToArray();
                    _playBuffer.AddSamples(pcm, 0, pcm.Length);
                }
            }
        }
    }

    private void SendText(string s)
    {
        var b = Encoding.UTF8.GetBytes(s);
        lock (_sendLock)
        {
            _ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Text, true, _cts.Token).GetAwaiter().GetResult();
        }
    }

    private void SendBinary(byte[] b)
    {
        lock (_sendLock)
        {
            _ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Binary, true, _cts.Token).GetAwaiter().GetResult();
        }
    }

    private static string Esc(string s) { return s == null ? "" : s.Replace("\\", "\\\\").Replace("\"", "\\\""); }
    private static void Log(string m) { Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + m); }
}
'@

Write-Step "Compiling audio engine (Add-Type)..."
Add-Type -TypeDefinition $cs -ReferencedAssemblies $naudio, "System.dll" -ErrorAction Stop

Write-Ok "Engine ready. Portal=$Portal Session=$Session Name=$Name Direction=$Direction Rate=$SampleRate"
if ($PlaybackDevice) { Write-Ok "audio.in  -> playback device matching '$PlaybackDevice'" }
if ($CaptureDevice)  { Write-Ok "audio.out <- loopback device matching '$CaptureDevice'" }
Write-Host "    Press Ctrl+C to stop." -ForegroundColor DarkGray

$bridge = New-Object CcPeepAudioBridge($Portal, $Session, $Name, $Direction, $SampleRate, $PlaybackDevice, $CaptureDevice)
$bridge.Run()
