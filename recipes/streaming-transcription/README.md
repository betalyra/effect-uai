---
title: Streaming transcription
description: Live captions while the user is still speaking. Browser mic to provider WebSocket, partials and finals.
---

Live captions arrive as the user speaks, not after they finish.

This recipe connects a browser microphone to a realtime transcription
provider. The browser sends small PCM frames to a Bun server; the
server turns those frames into a `Stream<Uint8Array>` and gets
transcript events back.

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
events as committed transcript lines. `index.ts` is provider-agnostic;
`run-bun.ts` chooses OpenAI Realtime or ElevenLabs.

## Run it

```sh
# Default: OpenAI Realtime (24 kHz pcm16)
OPENAI_API_KEY=sk-... bun recipes/streaming-transcription/run-bun.ts

# ElevenLabs Scribe v2 Realtime (16 kHz pcm16)
ELEVENLABS_API_KEY=... bun recipes/streaming-transcription/run-bun.ts --provider elevenlabs
```

Open <http://localhost:3000>, click **Start**, allow mic access, and
talk. Partial transcripts appear dimmed; finals commit and stay bold.

> Run with **`bun`**, not `pnpm tsx` — the runner uses `Bun.serve` and
> `Bun.build` globals.

Env vars: `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` depending on
provider; `PORT` optional (defaults to 3000).

## How The Demo Flows

```
[Browser]  getUserMedia → AudioWorklet → WebSocket
   ↕
[Bun server]  Stream<Uint8Array> → Transcriber.streamTranscriptionFrom
             → TranscriptEvent JSON
[Browser]  renders partial / final transcripts live
```

The server owns the Effect Layer and the provider connection; the
browser is just a mic-to-WS adapter. Sample rates differ per provider
(OpenAI wants 24 kHz, ElevenLabs wants 16 kHz), so the client fetches
`/config` before it starts recording.

## Provider Fit

Use a provider layer that registers the `SttStreaming` marker. That is
what keeps a sync-only provider from accidentally being used in a live
mic pipeline.

OpenAI Realtime and ElevenLabs both work here. Gemini's transcription
is sync-only, so it belongs in [Basic transcription](/recipes/basic-transcription/),
not this recipe.

## What This Generalizes To

Live transcription is usually the first half of a larger flow. Pipe
`final` events into search, commands, meeting notes, or an LLM. For the
full STT → LLM → TTS composition, see [Voice loop](/recipes/voice-loop/).

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-transcription/index.ts).
