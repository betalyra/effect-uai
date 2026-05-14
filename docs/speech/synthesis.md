---
title: Synthesis
description: Text in, audio out — one-shot, chunked, or token-streaming for low-latency TTS.
---

Reading an answer aloud and starting playback before the model has
finished writing are the same call with different inputs.

Use the simplest path that matches when your text exists:

- **Finished text, want a file**: `synthesize`.
- **Finished text, want early playback**: `streamSynthesis`.
- **Text is still streaming from an LLM**: `streamSynthesisFrom`.

## Three Modes

```ts
import {
  synthesize, // Effect — full text in, full bytes out
  streamSynthesis, // Stream — full text in, chunks out
  streamSynthesisFrom, // Stream — incremental text in, chunks out
} from "@effect-uai/core/SpeechSynthesizer"
```

- **`synthesize`** — finished text, single HTTP call, full
  `AudioBlob` back. Use it for "write to file", "attach to a message",
  or "drop into storage".
- **`streamSynthesis`** — finished text, audio arrives as a
  `Stream<AudioChunk>`. Start playback on the first chunk; cancel
  cheaply mid-stream.
- **`streamSynthesisFrom`** — incremental text as a `Stream<string>`,
  audio chunks back. This is the LLM pipe: token deltas in, audio out,
  no waiting for the full sentence. Gated by the
  [`TtsIncrementalText`](/speech/#capability-markers) marker so
  unsupporting providers fail at `Effect.provide`, not runtime.

## The Shape

```ts
type CommonSynthesizeRequest = {
  readonly text: string
  readonly model: string
  readonly voiceId: string
  readonly outputFormat?: AudioFormat
  readonly speed?: number
  readonly languageCode?: string
}

type CommonStreamSynthesizeRequest = Omit<CommonSynthesizeRequest, "text">
```

`voiceId` is `string` here. Each provider's typed request narrows it
to a literal union of stock voices plus a `(string & {})` escape for
custom cloned voices — except providers that don't expose cloning
(OpenAI, Gemini), whose typed request keeps `voiceId` stock-only and
rejects unknown values at the type level.

## Sync — `synthesize`

The "make me a file" path:

```ts
import { synthesize } from "@effect-uai/core/SpeechSynthesizer"

const blob = yield* synthesize({
  text: "Effect-uai. Effectful building blocks for agentic AI.",
  model: "gpt-4o-mini-tts",
  voiceId: "alloy",
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 24000 },
})
// blob.bytes : Uint8Array, blob.format : AudioFormat
```

## Chunked — `streamSynthesis`

The "I have the whole text, but playback can start early" path:

```ts
import { Stream } from "effect"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

const chunks = SpeechSynthesizer.streamSynthesis({
  text: "Effect-uai. Effectful building blocks for agentic AI.",
  model: "eleven_flash_v2_5",
  voiceId: "JBFqnCBsd6RMkjVDRZzb",
  outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
})
// Pipe to a speaker, file write, or WebSocket frame-by-frame.
```

Providers without a native chunked endpoint (Gemini today) don't ship
`streamSynthesis` at all — the call site is a compile error against
their Layer. ElevenLabs, OpenAI, and Inworld stream natively.

## Incremental text — `streamSynthesisFrom`

The "the text is still being written" path. Text arrives as deltas,
audio leaves as chunks, and the underlying WebSocket stays open for the
utterance. This is what voice agents use for LLM → TTS.

```ts
import { Stream } from "effect"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as Turn from "@effect-uai/core/Turn"

const audio = LanguageModel.streamTurn({
  history,
  model: "gemini-2.5-flash",
}).pipe(
  Stream.filterMap(Turn.toTextDelta),
  SpeechSynthesizer.streamSynthesisFrom({
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  }),
)
```

Today only `ElevenLabsSynthesizer` and `InworldRealtimeSynthesizer`
ship the `TtsIncrementalText` marker. Swap in `OpenAISynthesizer` or
`GeminiSynthesizer` and the call becomes a type error at
`Effect.provide` — TTS providers without a `/stream-input`-style
endpoint can't honor the contract.

The [Voice loop](/recipes/voice-loop/) recipe uses this exact pipe.

## What You Get Back

`synthesize` returns an `AudioBlob`. Both streaming variants return
`Stream<AudioChunk>`.

```ts
type AudioBlob = {
  readonly format: AudioFormat
  readonly bytes: Uint8Array
  readonly durationSeconds?: number
}

type AudioChunk = {
  readonly bytes: Uint8Array
}
```

Chunks carry encoded bytes at the declared `outputFormat`. There is no
per-chunk timestamp; playback pacing belongs to the client.

## Output Format

`outputFormat` declares the wire shape the audio should arrive in. Most
streaming TTS providers default to PCM s16le at 24 kHz or 48 kHz mono;
ElevenLabs additionally supports MP3 streams.

```ts
type AudioFormat = {
  readonly container: "mp3" | "wav" | "ogg" | "opus" | "flac" | "aac" | "webm" | "raw"
  readonly encoding: "pcm_s16le" | "pcm_f32le" | "mp3" | "opus" | ...
  readonly sampleRate: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000
  readonly channels?: 1 | 2
}
```

Pass `container: "raw"` with `encoding: "pcm_s16le"` for byte-pumping
into an `AudioWorklet` ring buffer (lowest-latency browser path). Pass
`container: "mp3"` for "drop into an `<audio>` tag" simplicity at the
cost of a few extra ms of decode.

## Next step

- [Voice loop](/recipes/voice-loop/) — `streamSynthesisFrom` plugged
  into an LLM with stop-word interrupt and turn queueing.
- [Basic speech synthesis](/recipes/basic-speech-synthesis/) — sync
  and chunked modes against OpenAI or Gemini.
- [Streaming synthesis](/recipes/streaming-synthesis/) — incremental
  text in over a Bun WebSocket, audio plays on the first chunk.

## See also

- [Transcription](/speech/transcription/) — the other direction.
- Provider specifics: [OpenAI](/speech/providers/openai/),
  [ElevenLabs](/speech/providers/elevenlabs/),
  [Gemini](/speech/providers/gemini/),
  [Inworld](/speech/providers/inworld/).
