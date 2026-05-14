---
title: Streaming synthesis
description: Audio starts playing on the first chunk, not the last. Incremental text-in over WebSocket.
---

Audio should start while the text is still being written.

This recipe sends incremental text into a streaming TTS provider and
plays audio chunks as they arrive. It is the shape you want when an LLM
is still producing the answer, but the user should already be hearing
the first phrase.

**Scenario.** You're reading model output aloud. The model writes
quickly but not instantly, and you don't want the user staring at a
spinner while a paragraph renders end-to-end. As soon as the model
has written enough text for the first phrase, you want the user to
hear it.

## The Shape

`streamSynthesisFrom` turns text deltas into audio chunks:

```ts
import { Stream } from "effect"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

const audio = textWords.pipe(
  // textWords : Stream<string>  (e.g. words typed by the user)
  SpeechSynthesizer.streamSynthesisFrom({
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  }),
)
// audio : Stream<AudioChunk, AiError>
```

The input can be words typed by a user, tokens from a language model,
or any other `Stream<string>`. The provider connection stays open for
the whole utterance, so playback can begin before the final text exists.

## Run it

```sh
ELEVENLABS_API_KEY=... bun recipes/streaming-synthesis/run-bun.ts
```

Open <http://localhost:3000>, paste text, click **Synthesize**. Audio
should start within ~500 ms regardless of how long the text is.

> Run with **`bun`**, not `pnpm tsx` — uses `Bun.serve` and
> `Bun.build` globals.

## How The Demo Flows

```
[Browser]  text  →  WebSocket
   ↕
[Bun server]  split text into words → Stream<string>
             → SpeechSynthesizer.streamSynthesisFrom
             → AudioChunk bytes
[Browser]  schedules each PCM chunk for playback
```

The browser demo uses raw PCM so it can schedule chunks directly. An
application could just as easily forward the chunks to another client,
write them to a file, or pipe them through a telephony connection.

This is the symmetric counterpart to
[Streaming transcription](/recipes/streaming-transcription/). Same
Bun + bundled-client pattern; only the data direction flips.

## Provider Fit

Use a provider layer that registers `TtsIncrementalText`. ElevenLabs
and Inworld fit this shape today. OpenAI and Gemini can synthesize
finished text, but they do not accept incremental text input, so use
[Basic speech synthesis](/recipes/basic-speech-synthesis/) with those
providers.

## What This Generalizes To

To plug an LLM into the upstream side, replace the user's typed words
with the model's text deltas. [Voice loop](/recipes/voice-loop/) does
exactly that: LLM `Stream<string>` in, streaming TTS audio out.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-synthesis/index.ts).
