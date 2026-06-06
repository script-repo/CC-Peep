using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace CcPeep.Audio;

/// <summary>
/// Plays PCM frames into the VM's default render device. Decode incoming WebRTC
/// audio (the audio.in channel from the web client) and push the PCM bytes through
/// <see cref="Enqueue"/>; they buffer and play back in real time.
/// </summary>
public sealed class AudioPlayback : IDisposable
{
    private readonly WasapiOut _output;
    private readonly BufferedWaveProvider _buffer;

    public AudioPlayback(WaveFormat format, MMDevice? device = null)
    {
        _buffer = new BufferedWaveProvider(format)
        {
            // ~2s of slack so transient network jitter doesn't starve playback.
            BufferDuration = TimeSpan.FromSeconds(2),
            DiscardOnBufferOverflow = true,
        };

        _output = device is null
            ? new WasapiOut(AudioClientShareMode.Shared, 50)
            : new WasapiOut(device, AudioClientShareMode.Shared, true, 50);

        _output.Init(_buffer);
    }

    public void Start() => _output.Play();

    public void Stop() => _output.Stop();

    /// <summary>Queue decoded PCM (must match the format passed to the constructor).</summary>
    public void Enqueue(byte[] pcm, int offset, int count) => _buffer.AddSamples(pcm, offset, count);

    public void Enqueue(byte[] pcm) => Enqueue(pcm, 0, pcm.Length);

    public void Dispose()
    {
        _output.Dispose();
    }
}
