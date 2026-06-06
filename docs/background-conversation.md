# Background Conversation

This is the source conversation that frames the goal of the **audio agents** project:
streaming audio **into and out of a Windows virtual machine over an API**, with a
web-based interface acting as the client.

---

## Topic: Streaming audio input and output to a Windows VM via API

> **Question:** How can I stream the audio input and output to a Windows virtual
> machine via API?

Streaming both audio input and output to a Windows virtual machine usually involves
capturing the audio on your local device, sending it over a network, and playing it
back in the VM. An API for this depends on what environment you're in, but here are
the general steps:

1. **Local capture.** You need an audio capture component on your local machine. On
   Windows you might use the **WASAPI** API. Other platforms have similar libraries.
2. **Network streaming.** To stream the audio to the VM, use a network protocol like
   **RTP** or **WebRTC**. Libraries like **GStreamer** or **FFmpeg** can package and
   send the audio data.
3. **VM-side playback.** On the VM you need a service that receives the stream and
   plays it. This could be a custom application using the same libraries, or a remote
   desktop solution like **RDP** that already supports audio redirection.

If you want to avoid building this from scratch, consider Microsoft's **Remote Desktop
Protocol** or third-party tools such as **Parsec** or **AnyDesk**, which handle audio
in and out. For a custom API-driven approach, look into **WebRTC** libraries or audio
streaming frameworks you can integrate into your application.

---

## Refinement: Stream to an API over WebSockets

> **Clarification:** I want to be able to stream it to an API. Say I have a web server
> with a WebSocket connection, and a Windows stream — one channel over to a WebSocket
> for input, one channel over to a WebSocket for audio output.

The web-based interface is able to act as the **client**.

To stream audio input and output from a Windows virtual machine through a web-based
interface, a few pieces work together:

1. **Capture/playback on the VM.** Tools like the **Windows Core Audio APIs** or
   **NAudio** can grab microphone input and system output.
2. **Server component on the VM.** A small application encodes audio using a format
   like **Opus** or **AAC**, then sends it over a **WebSocket** to your web server.
3. **Relay on the web server.** The web server relays that audio to the browser via
   **WebSocket** or **WebRTC**. WebRTC is built for real-time audio, but WebSockets
   work too — you just handle encoding/decoding on both ends.
4. **Browser client.** JavaScript receives audio from the WebSocket and plays it, and
   captures microphone input to send back. The **Web Audio API** helps with playback
   and **getUserMedia** captures the microphone.

### Basic flow

```
VM captures audio ──(encode)──> WebSocket ──> Web server (relay) ──> Browser plays
Browser captures mic ──> Web server (relay) ──> WebSocket ──> VM plays
```

It takes some coding and careful handling of audio formats, but it's doable.
Recommended starting points: **NAudio** for Windows-side capture/playback, and
**WebRTC**/**Web Audio API** examples for the browser.
