using CcPeep.Audio;
using NAudio.CoreAudioApi;
using NAudio.Wave;

// cc-peep-audio — NAudio (WASAPI) audio engine for the Windows VM client.
//
// Standalone CLI today; the AudioCapture / AudioPlayback classes are the integration
// surface for the WebRTC peer (see README). Commands:
//
//   list                      enumerate render + capture devices
//   loopback <secs> <out.wav> record system output (audio.out source) to a WAV
//   mic      <secs> <out.wav> record the default microphone to a WAV
//   play     <in.wav>         play a WAV through the default render device
//   monitor  <secs>           live passthrough: system output -> speakers (round-trip)

if (args.Length == 0)
{
    PrintUsage();
    return 0;
}

try
{
    switch (args[0].ToLowerInvariant())
    {
        case "list":
            ListDevices();
            break;
        case "loopback":
            Record(CaptureSource.SystemLoopback, Seconds(args, 1, 5), PathArg(args, 2, "loopback.wav"));
            break;
        case "mic":
            Record(CaptureSource.Microphone, Seconds(args, 1, 5), PathArg(args, 2, "mic.wav"));
            break;
        case "play":
            Play(PathArg(args, 1, null) ?? throw new ArgumentException("play needs a .wav path"));
            break;
        case "monitor":
            Monitor(Seconds(args, 1, 10));
            break;
        default:
            PrintUsage();
            return 1;
    }
}
catch (Exception ex)
{
    Console.Error.WriteLine($"error: {ex.Message}");
    return 1;
}

return 0;

static int Seconds(string[] args, int i, int fallback) =>
    args.Length > i && int.TryParse(args[i], out var s) ? s : fallback;

static string? PathArg(string[] args, int i, string? fallback) =>
    args.Length > i ? args[i] : fallback;

static void ListDevices()
{
    using var enumerator = new MMDeviceEnumerator();
    Console.WriteLine("Render devices (playback):");
    foreach (var d in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        Console.WriteLine($"  - {d.FriendlyName}");
    Console.WriteLine("Capture devices (microphone/line-in):");
    foreach (var d in enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
        Console.WriteLine($"  - {d.FriendlyName}");
}

static void Record(CaptureSource source, int seconds, string outPath)
{
    using var capture = new AudioCapture(source);
    using var writer = new WaveFileWriter(outPath, capture.Format);

    capture.FrameAvailable += (_, e) => writer.Write(e.Pcm, 0, e.Pcm.Length);

    Console.WriteLine($"Recording {source} for {seconds}s -> {outPath} ({capture.Format})");
    capture.Start();
    Thread.Sleep(TimeSpan.FromSeconds(seconds));
    capture.Stop();
    Thread.Sleep(200); // let the final buffer flush
    Console.WriteLine($"Wrote {outPath} ({new FileInfo(outPath).Length:n0} bytes)");
}

static void Play(string inPath)
{
    using var reader = new AudioFileReader(inPath);
    using var output = new WasapiOut();
    output.Init(reader);
    Console.WriteLine($"Playing {inPath}…");
    output.Play();
    while (output.PlaybackState == PlaybackState.Playing)
        Thread.Sleep(100);
}

static void Monitor(int seconds)
{
    using var capture = new AudioCapture(CaptureSource.SystemLoopback);
    using var playback = new AudioPlayback(capture.Format);

    capture.FrameAvailable += (_, e) => playback.Enqueue(e.Pcm);

    Console.WriteLine($"Monitoring system audio -> speakers for {seconds}s ({capture.Format})");
    playback.Start();
    capture.Start();
    Thread.Sleep(TimeSpan.FromSeconds(seconds));
    capture.Stop();
    playback.Stop();
}

static void PrintUsage()
{
    Console.WriteLine(
        """
        cc-peep-audio — NAudio (WASAPI) audio engine

        Usage:
          cc-peep-audio list
          cc-peep-audio loopback <secs> <out.wav>
          cc-peep-audio mic      <secs> <out.wav>
          cc-peep-audio play     <in.wav>
          cc-peep-audio monitor  <secs>
        """);
}
