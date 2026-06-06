using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace CcPeep.Audio;

/// <summary>Which device a capture session reads from.</summary>
public enum CaptureSource
{
    /// <summary>System output (what the VM is playing) via WASAPI loopback — the audio.out channel.</summary>
    SystemLoopback,
    /// <summary>A capture device (microphone / line-in).</summary>
    Microphone,
}

/// <summary>Raised for each captured PCM buffer.</summary>
public sealed class AudioFrameEventArgs : EventArgs
{
    public AudioFrameEventArgs(byte[] pcm, WaveFormat format)
    {
        Pcm = pcm;
        Format = format;
    }

    /// <summary>A copy of the captured PCM bytes (safe to hand off to another thread).</summary>
    public byte[] Pcm { get; }

    /// <summary>The wave format the bytes are encoded in (device mix format).</summary>
    public WaveFormat Format { get; }
}

/// <summary>
/// Wraps WASAPI capture (system loopback or microphone) and surfaces raw PCM frames.
/// Feed <see cref="FrameAvailable"/> into an encoder (Opus) + WebRTC track to publish
/// the audio.out channel toward the web client.
/// </summary>
public sealed class AudioCapture : IDisposable
{
    private readonly IWaveIn _capture;

    public AudioCapture(CaptureSource source, MMDevice? device = null)
    {
        _capture = source switch
        {
            // WasapiLoopbackCapture taps the render endpoint's output stream.
            CaptureSource.SystemLoopback => device is null
                ? new WasapiLoopbackCapture()
                : new WasapiLoopbackCapture(device),
            // WasapiCapture reads a capture endpoint (default: the default mic).
            CaptureSource.Microphone => device is null
                ? new WasapiCapture()
                : new WasapiCapture(device),
            _ => throw new ArgumentOutOfRangeException(nameof(source)),
        };

        _capture.DataAvailable += OnDataAvailable;
        _capture.RecordingStopped += (_, e) => RecordingStopped?.Invoke(this, e);
    }

    /// <summary>The format the device delivers (typically 32-bit IEEE float, device sample rate).</summary>
    public WaveFormat Format => _capture.WaveFormat;

    /// <summary>Fired on the capture thread for every buffer of PCM data.</summary>
    public event EventHandler<AudioFrameEventArgs>? FrameAvailable;

    public event EventHandler<StoppedEventArgs>? RecordingStopped;

    public void Start() => _capture.StartRecording();

    public void Stop() => _capture.StopRecording();

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (e.BytesRecorded == 0) return;
        var copy = new byte[e.BytesRecorded];
        Buffer.BlockCopy(e.Buffer, 0, copy, 0, e.BytesRecorded);
        FrameAvailable?.Invoke(this, new AudioFrameEventArgs(copy, _capture.WaveFormat));
    }

    public void Dispose()
    {
        _capture.DataAvailable -= OnDataAvailable;
        _capture.Dispose();
    }
}
