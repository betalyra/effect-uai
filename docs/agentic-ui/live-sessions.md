---
title: Live sessions
description: "Mic in, speech out: one WebSocket carrying typed envelopes and binary media both ways, with formats declared on the stream."
---

When media flows continuously (a mic, a camera, speech coming back), a
request per input is the wrong shape: the upstream is itself a stream. A
**live session** is one WebSocket carrying both directions:

- **text frames** are JSON: envelopes going down, your own messages going up;
- **binary frames** are media: a big-endian u16 channel, then the bytes.

Media frames are not sequenced and never stored. Everything else is the
protocol you already know: envelopes with `seq`, runs, `data`, `live`, and
`StreamView` on the client.

## Channels

A `channel-opened` event declares a channel's format, so the page never
fetches a config route:

```ts
{ type: "channel-opened", channel: 0, direction: "up", mimeType: "audio/pcm", sampleRate: 16000 }
```

`direction: "down"` is media the server sends (play it); `"up"` is what the
server expects from the client (record at that rate). `audio/pcm` is s16le.
A channel opened inside a run belongs to it and closes when the run ends,
so stopping a spoken reply tells the page which audio to drop. The numbers
are yours.

## Server: `LiveSocket.handle`

The session is a stream transformer from what the client sends to what it
receives:

```ts
import * as Frame from "@effect-uai/ui/Frame"
import * as LiveSocket from "@effect-uai/ui/LiveSocket"

const Say = Schema.Struct({ text: Schema.String })

HttpRouter.add(
  "GET",
  "/ws",
  LiveSocket.handle({
    up: Say, // the app's upstream messages
    handler: (up) => up.pipe(speechSession, Frame.sequence(streamId)),
  }),
)
```

`up` is a `Stream<Frame<Say>>`: `Message` frames carry your messages,
`Media` frames carry `{ channel, bytes }`. The handler returns
`Frame<Run.Owned>` (events tagged with `Run.within` or `Run.streamScoped`,
plus media), and `Frame.sequence` numbers the events while media passes
through in place.

When the client closes, the handler is interrupted; when the handler's
stream ends, the socket closes. Because the handler is a plain stream, a
test drives it without a socket. `LiveSocket.run(socket, options)` does
the same over any socket you already have.

## Client: `Transport.live` and `Atoms.live`

```ts
const session = Atoms.live({
  runtime: Atom.runtime(Socket.layerWebSocketConstructorGlobal),
  transport: Transport.live({ connect: Transport.socket("/ws"), up: Say }),
  initial: StreamView.empty<UiContract.Payloads<typeof SpeechUi>>(),
  step: StreamView.step,
  decode: SpeechUi.decode,
  media: (frame) => Effect.sync(() => player.push(frame.bytes)), // never through atoms
})

registry.set(session.connect, undefined)
registry.set(session.send, Frame.message({ text: "Hello there." }))
registry.set(session.send, Frame.media(0, micBytes))
registry.get(session.state).channels[0] // what to play, or what to record
```

`connect` opens a session from `initial`; connecting again or
`disconnect` closes it. `connected` says whether one is open. There is no
resume: a dropped live session is a new one.

## In the browser: `@effect-uai/ui/Media`

The devices, as Effect streams. Each owns its device and audio graph
through its scope, so interrupting the fiber releases the microphone or
camera, and the AudioWorklets ship inline (no worklet files to serve):

```ts
import * as Media from "@effect-uai/ui/Media"

// Record at the rate the server declared on its `up` channel.
Media.mic({ sampleRate: channel.sampleRate }).pipe(
  Stream.runForEach((bytes) => send(Frame.media(MIC, bytes))),
)

Media.camera({ source: "camera", fps: 1, maxSide: 768, preview: videoEl }) // JPEG stills
Media.level(micFrames) // RMS per frame, for meters and gates

const player = yield * Media.pcmPlayer({ sampleRate: 24000 }) // scoped
yield * player.push(bytes) // queue 16-bit PCM
yield * player.clear // a stopped reply: drop what is queued
yield * player.played // ms heard since the last clear or reset
```

`Media` is browser only and not in the package index; import the
subpath. It is the only part of the package that touches the DOM.

## Speech on the server: projections

Two folds map core's speech events onto the protocol, so a server rarely
writes events by hand:

- `Projection.fromTranscript()`: a live transcript as one `data
"transcript"` entry per utterance (`Projection.Utterance`), partials
  overwriting it until its final. Type the entry in your contract with
  `Projection.Utterance`.
- `Projection.fromRealtime({ channel, format })`: a realtime session as
  frames. Each response is a run that opens its own audio channel and
  streams `text-delta`s; its audio goes out as media; tool calls become
  `tool-call-ready`, and calls the model abandons close as a cancelled
  `tool-result`. An interruption ends the run with
  `run-stopped { reason: "barge-in" }`, which closes its channel, so the
  page knows to drop the audio it still holds.

Running tools stays yours: answer a `tool-call-ready` with a
`tool-result` in the call's run.

When an answer is cut off, only the page knows how much of it was
heard. `Input.Playback { channel, playedMs }` is the message for that:
read `player.played`, send it, and the server can trim what the
listener missed (`RealtimeInput.PlaybackPosition`).

## Recipes

- [Streaming transcription](/recipes/streaming-transcription/): the mic
  goes up on a channel the server declares; utterances come down as
  entries.
- [Streaming synthesis](/recipes/streaming-synthesis/): lines go up as
  messages; speech comes down on one channel.
- [Voice loop](/recipes/voice-loop/): STT, LLM and TTS as one session;
  each reply a run with its own channel, a stop word ends it.
- [Realtime voice agent](/recipes/realtime-voice-agent/):
  `fromRealtime`, tools beside the conversation, and `Playback` after a
  barge-in.
- [Camera assistant](/recipes/camera-assistant/): the same, plus camera
  stills on a channel of their own, gated by `Media.level`.
