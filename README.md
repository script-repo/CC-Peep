# audio agents

Stream audio **into and out of a Windows virtual machine over an API**, using a web
server as a WebSocket relay and a browser as the client.

```
VM captures audio ──(encode)──> WebSocket ──> relay ──> browser plays
browser captures mic ──> relay ──> WebSocket ──> VM plays
```

## Layout

| Folder        | What lives here                                                       |
| ------------- | --------------------------------------------------------------------- |
| `docs/`       | Background conversation and architecture notes                        |
| `server/`     | WebSocket relay server (Node.js)                                      |
| `web-client/` | Browser client: playback (Web Audio API) + mic capture (getUserMedia) |
| `vm-agent/`   | Windows VM audio capture/playback agent (NAudio)                      |
| `shared/`     | Wire protocol / message schema shared across components               |

## Start here

1. [`docs/background-conversation.md`](docs/background-conversation.md) — the framing discussion.
2. [`docs/architecture.md`](docs/architecture.md) — components, data flow, and open decisions.

This is an early scaffold — each component folder currently holds a README describing
its intended role. Implementation comes next.
