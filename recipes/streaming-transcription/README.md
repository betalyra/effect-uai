---
title: Streaming transcription
description: Live captions while the user is still speaking. Browser mic to provider WebSocket, partials and finals.
source: recipes/streaming-transcription
---

Live captions arrive as the user speaks, not after they finish.

This recipe connects a browser microphone to a realtime transcription
provider. The browser sends small PCM frames over one live session; the
server turns those frames into a `Stream<Uint8Array>` and sends the
transcript back as entries.

**Scenario.** You're building a captioning UI, a voice-search box, or
the front half of a voice assistant. You want partial guesses to
appear dimmed while the user is mid-sentence and finals to commit
once they pause.

## The Shape

`streamTranscriptionFrom` is live STT as a stream transformation:

```ts
import { Stream } from "effect"
import * as Transcriber from "@effect-uai/core/Transcriber"

const transcripts = micFrames.pipe(
  Transcriber.streamTranscriptionFrom({
    model: "scribe_v2_realtime",
    inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
    interimResults: true,
  }),
)

// transcripts : Stream<TranscriptEvent, AiError>
// each event is "partial" | "final" | "speech-started" | ...
```

The recipe UI renders `partial` events as tentative text and `final`
events as committed transcript lines. `recipe.ts` is provider-agnostic;
`run.ts` chooses OpenAI Realtime or ElevenLabs.

## Run it

```sh
# Default: OpenAI Realtime (24 kHz pcm16)
OPENAI_API_KEY=sk-... pnpm tsx recipes/streaming-transcription/run.ts

# ElevenLabs Scribe v2 Realtime (16 kHz pcm16)
ELEVENLABS_API_KEY=... pnpm tsx recipes/streaming-transcription/run.ts --provider elevenlabs
```

Open <http://localhost:3000>, click **Start**, allow mic access, and
talk. Partial transcripts appear dimmed; finals commit and stay bold.

Env vars: `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` / `INWORLD_API_KEY`
depending on provider; `PORT` optional (defaults to 3000).

## The live session

The page and the server talk over one
[live session](/agentic-ui/live-sessions/) from `@effect-uai/ui`:

```
[Browser]  getUserMedia → AudioWorklet → media frames on channel 0
   ↕  one WebSocket
[Server]  channel 0 → Stream<Uint8Array> → Transcriber.streamTranscriptionFrom
          → data "utterance" entries
[Browser]  StreamView folds them; partials dim, finals bold
```

The session opens by declaring the mic channel: `channel-opened` with
`direction: "up"` and the provider's sample rate (OpenAI wants 24 kHz,
ElevenLabs 16 kHz). The page starts recording at that rate, so it needs
no config route. Each utterance is one `data` entry: its partials
overwrite it, its final settles it, and the next utterance gets the
next id.

```ts
LiveSocket.handle({
  up: Schema.Never, // nothing goes up but mic audio
  handler: (up) =>
    up.pipe(
      transcriptSession(provider), // RunEvents: the mic channel, then entries
      Run.streamScoped,
      Stream.map(Frame.message),
      Frame.sequence(streamId),
    ),
})
```

## Provider Fit

Use a provider layer that registers the `SttStreaming` marker. That is
what keeps a sync-only provider from accidentally being used in a live
mic pipeline.

OpenAI Realtime and ElevenLabs both work here. Gemini's transcription
is sync-only, so it belongs in [Basic transcription](/recipes/basic-transcription/),
not this recipe.

Two per-provider facts sit in `providerConfig` next to the model and
sample rate. `vadEvents` asks the server to find turn boundaries, which
is what commits a turn into a `final`; a model that transcribes
continuously rejects it and then only ever emits partials.
`joinPartials` pipes the stream through
`Transcript.accumulatePartials()` for providers that stream token-sized
deltas instead of the whole utterance so far, which is what OpenAI does.

## What This Generalizes To

Live transcription is usually the first half of a larger flow. Pipe
`final` events into search, commands, meeting notes, or an LLM. For the
full STT → LLM → TTS composition, see [Voice loop](/recipes/voice-loop/).

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-transcription/recipe.ts).
