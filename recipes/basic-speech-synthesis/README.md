---
title: Basic speech synthesis
description: Text in, audio out. One service, two ways to consume it, two providers.
source: recipes/basic-speech-synthesis
---

Reading text aloud should not force your app into a provider SDK.

This recipe turns text into playable audio. Use the one-shot path when
you want a complete file, or the chunked path when playback should
start before the whole response has downloaded.

**Scenario.** You're building a podcast generator, a notification
reader, or an accessibility feature. You need to turn a string into
audio and save it, send it, or play it.

## Two Ways To Listen

```ts
import { synthesize, streamSynthesis } from "@effect-uai/core/SpeechSynthesizer"

// One-shot
const blob =
  yield *
  synthesize({
    text: "Effect-uai. Effectful building blocks for agentic AI.",
    model: "gpt-4o-mini-tts",
    voiceId: "alloy",
  })
yield * writeFile("out.mp3", blob.bytes)

// Chunked
const chunks = streamSynthesis({ text, model, voiceId })
// chunks : Stream<AudioChunk, AiError>
```

`synthesize` is the "make me a file" path. `streamSynthesis` is the
"start playing as bytes arrive" path. Both use the generic
`SpeechSynthesizer` service, so provider choice stays in the Layer.

The demo collects the streaming chunks so it can write a file. A real
app usually pipes them directly to a speaker, file writer, or WebSocket.

## Providers

| Provider           | Model                          | Voice   | Output                                            |
| ------------------ | ------------------------------ | ------- | ------------------------------------------------- |
| `openai` (default) | `gpt-4o-mini-tts`              | `alloy` | mp3                                               |
| `gemini`           | `gemini-2.5-flash-preview-tts` | `Kore`  | wav (PCM wrapped with RIFF header by the adapter) |

Each provider keeps its own voice catalog on the typed request. The
portable recipe only needs `voiceId: string`; the Layer decides what is
valid for the provider you picked.

## Run it

```sh
# Defaults: --provider openai --mode one-shot
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-speech-synthesis/run-node.ts

# Streaming only
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-speech-synthesis/run-node.ts --mode streaming

# Both modes, Gemini
GOOGLE_API_KEY=... pnpm tsx recipes/basic-speech-synthesis/run-node.ts --provider gemini --mode both
```

Writes `out-oneshot.<ext>` and/or `out-streaming.<ext>` next to the
recipe, where `<ext>` matches the provider's native output.

## What This Generalizes To

This recipe starts with finished text. If the text itself is still
being produced, use [Streaming synthesis](/recipes/streaming-synthesis/)
instead: `streamSynthesisFrom` takes a `Stream<string>` of model deltas
and turns them into audio chunks as they arrive. The
[Voice loop](/recipes/voice-loop/) uses that shape for LLM → TTS.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-speech-synthesis/index.ts).
