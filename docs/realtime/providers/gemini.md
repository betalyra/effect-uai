---
title: Gemini Live
description: Native-audio speech-to-speech, with camera input and resumable sessions.
---

Use this when you want a voice agent that can also see: Gemini Live is
the provider that takes camera frames on the same session as the audio.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

No peer dependency and no header auth, so this runs on Node, Bun and
Deno. It would run in a browser too, but the key rides in the URL and
ephemeral tokens are not implemented here, so keep the session on a
server.

## Layer

| Layer                                  | Registers                               | Capability markers   |
| -------------------------------------- | --------------------------------------- | -------------------- |
| `@effect-uai/google/GeminiLiveSession` | `GeminiLiveSession` + `RealtimeSession` | `RealtimeVideoInput` |

```ts
import { Config, Effect, Layer } from "effect"
import { layer as liveLayer } from "@effect-uai/google/GeminiLiveSession"

const gemini = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return liveLayer({ apiKey })
  }),
)
```

## Models

| Model                                           | Notes                                     |
| ----------------------------------------------- | ----------------------------------------- |
| `gemini-3.1-flash-live-preview`                 | Recommended; thinking via `thinkingLevel` |
| `gemini-2.5-flash-native-audio-preview-12-2025` | Proactive audio and affective dialog      |

Both are native audio: output is audio, and the assistant transcript you
see is the model's own output transcription rather than a text modality.
Send mono `pcm_s16le` at any rate (16 kHz is what the model works in);
output is fixed at 24 kHz.

## Sending Video

```ts
import * as RealtimeSession from "@effect-uai/core/RealtimeSession"

yield *
  RealtimeSession.sendVideoFrame(session, {
    _tag: "bytes",
    bytes: jpeg,
    mimeType: "image/jpeg",
  })
```

One frame per message, at most one per second, and around 768 px square.
Frames must carry their bytes: a URL would need an upload through the
Files API first, so it fails `Unsupported`.

Frames are billed, and on 3.1 every frame between turns counts. Send
them only while the user is speaking, or set `turnCoverage: "activity"`.
`mediaResolution: "low"` cuts the cost per frame.

## Tuning Turn-Taking

```ts
const session =
  yield *
  GeminiLiveSession.open({
    model: "gemini-3.1-flash-live-preview",
    voiceId: "Kore",
    inputFormat: pcm16k,
    outputFormat: pcm24k,
    vad: { endSensitivity: "low", silenceDurationMs: 700 },
    thinkingLevel: "minimal",
  })
```

`activityHandling: "none"` turns barge-in off, so the model finishes what
it is saying. `turnDetection: "manual"` disables detection entirely and
gives you the boundaries through `ActivityStart` and `ActivityEnd`.

Yield the typed `GeminiLiveSession` tag to reach these; the generic
`RealtimeSession` tag takes the common request only.

## Grounding

`googleSearch: true` lets the model answer from the web. It cannot share
a session with your own tools, which the API rejects outright, so asking
for both fails `InvalidRequest` before the socket opens. Run a grounded
session or a tool session, not both.

## Sessions End After Ten Minutes

The socket has a hard limit whatever you do. `SessionEnding` arrives
about a minute before, and every session asks for resumption, so you get
`ResumptionHandle` events as the conversation goes:

```ts
Match.tag("ResumptionHandle", (e) => Ref.set(lastHandle, e.handle))
```

Open a new session with `resume: handle` and the conversation continues.
Everything but `model` may change on the way. Reconnecting is yours; the
adapter never does it behind your back. The close that follows `goAway`
fails the stream with `SessionExpired`, so the cap is one error to match
on rather than a stream that quietly ends.

Sessions also have a token budget: about 15 minutes of audio, or 2
minutes with video, before the context window fills. Set
`contextCompression` to make that unbounded, at the price of a latency
spike when it triggers.

## What This Provider Cannot Do

- **Trim what was not heard.** There is no truncate op, so
  `PlaybackPosition` is dropped with a warning and audio the server sent
  stays in context whether or not anyone heard it.
- **Cancel on demand.** `Interrupt` fails `Unsupported`; interruption is
  the server's own, configured through `activityHandling`.
- **Change the system instruction mid-session.** It is fixed at setup,
  so `Text` with `role: "system"` fails `Unsupported`.

## See also

- [Realtime](/realtime/): the session shape and the event loop.
- [Gemini](/providers/gemini/) for language-model use of the same key.
