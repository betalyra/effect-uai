---
title: OpenAI Realtime
description: Speech-to-speech over one WebSocket, with server VAD, tools and truncation.
---

Use this when you want a voice agent that interrupts cleanly and forgets
the part of its answer nobody heard.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/openai effect ws
```

`ws` is a peer dependency: the upgrade needs an `Authorization` header,
which the browser `WebSocket` API cannot set. Node and Bun only.

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

No `RealtimeVideoInput`: this provider takes still images as
conversation items but has no video input, so `sendVideoFrame` against
this Layer alone is a compile error.

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

Speech is reported as `SpeechStarted`, then `Interrupted` for the
response being cancelled, then its `ResponseDone`. Unanswered tool calls
of that response arrive as `ToolCallCancelled`.

`SpeechStarted` is the voice detector firing, so a cough or a door sets
it off. Stop playback on `Interrupted` instead: it comes only once the
server has actually abandoned the answer. Transcripts are no better as a
trigger, since they land late and out of order against the response.

Send `PlaybackPosition` with the milliseconds your client actually
played and the unheard tail is trimmed from the conversation. That works
even after `ResponseDone`, which is the common case: the model finishes
generating long before the speakers catch up.

## Session Limits

The server sets an expiry at connect and `SessionEnding` arrives a
minute before it. The close that follows fails the stream with
`SessionExpired` rather than ending it, so the cap is not mistaken for
the conversation being over. There is no resumption on this provider, so continuing
means a new session with your own history. `resume` is refused with
`Unsupported` rather than ignored, so a handle from elsewhere cannot
quietly open a blank session.

## See also

- [Realtime](/realtime/): the session shape and the event loop.
- [Compatible endpoints](/realtime/gateways/): pointing this Layer at
  an OpenAI-shaped gateway.
