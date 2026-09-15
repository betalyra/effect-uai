---
title: OpenAI Realtime
description: Speech-to-speech over one WebSocket, with server VAD, tools and truncation.
---

The default provider for a voice agent: audio only, with the cleanest
interruption handling, since it can forget the part of an answer nobody
heard.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/openai effect ws
```

`ws` is a peer dependency, so this runs on Node and Bun. From a browser,
go through your own server.

## Layer

| Layer                                      | Registers                                   | Capability markers |
| ------------------------------------------ | ------------------------------------------- | ------------------ |
| `@effect-uai/openai/OpenAIRealtimeSession` | `OpenAIRealtimeSession` + `RealtimeSession` | none               |

```ts
import { Config, Effect, Layer } from "effect"
import { layer as realtimeLayer } from "@effect-uai/openai/OpenAIRealtimeSession"

const openai = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return realtimeLayer({ apiKey })
  }),
)
```

No video: `sendVideoFrame` does not compile against this Layer. For a
camera, use [Gemini Live](/realtime/providers/gemini/).

## Models

| Model                   | Notes                              |
| ----------------------- | ---------------------------------- |
| `gpt-realtime-2.1`      | The current speech-to-speech model |
| `gpt-realtime-2.1-mini` | Cheaper and faster                 |

Audio is `pcm_s16le` at 24 kHz in both directions, or 8 kHz `pcm_mulaw`
/ `pcm_alaw` for telephony. Anything else fails `Unsupported` at `open`.

## Tuning Turn-Taking

The default is server VAD, which ends your turn on silence. Two knobs
change how it feels:

```ts
const session =
  yield *
  OpenAIRealtimeSession.open({
    model: "gpt-realtime-2.1",
    voiceId: "marin",
    inputFormat: pcm24k,
    outputFormat: pcm24k,
    // Waits for you to sound finished rather than merely quiet.
    turnDetectionConfig: { type: "semantic_vad", eagerness: "low" },
    // Helps in a noisy room.
    noiseReduction: "far_field",
  })
```

`turnDetection: "manual"` turns detection off entirely and hands you the
turn boundaries through `ActivityStart` and `ActivityEnd`. Use it when
your client has a push-to-talk button.

Yield the typed `OpenAIRealtimeSession` tag to reach these; the generic
`RealtimeSession` tag takes the common request only.

## Other Options

`speed` slows or speeds the voice. `reasoningEffort` and
`maxOutputTokens` behave as they do elsewhere. `truncation` decides what
happens as the conversation outgrows the context window, and
`outputModalities: "text"` turns the session into a text-only
responder. `transcriptionModel` picks the model that transcribes your
speech, defaulting to `gpt-live-transcribe`.

## Barge-In

When the user starts talking you get `SpeechStarted`. If the model
decides that was an interruption, `Interrupted` follows, then the
cancelled response's `ResponseDone`, and any tool calls it was still
waiting on arrive as `ToolCallCancelled`.

Stop playback on `Interrupted`, not `SpeechStarted`: the detector also
fires on a cough or a door, and only `Interrupted` means the answer was
actually abandoned.

Send `PlaybackPosition` with the milliseconds your client played and
the unheard tail is trimmed from the conversation. This works after
`ResponseDone` too, which is the usual case, since the model finishes
generating long before the speakers catch up.

## Session Limits

Sessions have a fixed lifetime set at connect. `SessionEnding` arrives
a minute before it, and the close that follows fails the stream with
`SessionExpired`. There is no resumption: to continue, open a new
session and replay your own history. Passing `resume` fails
`Unsupported`.

## See also

- [Realtime](/realtime/): the session shape and the event loop.
- [Compatible endpoints](/realtime/gateways/): pointing this Layer at
  an OpenAI-shaped gateway.
