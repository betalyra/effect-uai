---
title: Speech
description: Two service tags — Transcriber and SpeechSynthesizer — that cross the audio boundary in either direction.
---

Speech work usually starts with one of two user problems: "turn this
audio into text" or "read this text aloud."

`Transcriber` carries audio into text. `SpeechSynthesizer` carries text
into audio. Each has a simple path for finished inputs and a streaming
path for live interfaces.

## Start With The User Flow

- **Finished audio file → transcript**: use
  [Basic transcription](/recipes/basic-transcription/) or
  [`transcribe`](/speech/transcription/).
- **Live mic → captions**: use
  [Streaming transcription](/recipes/streaming-transcription/) or
  [`streamTranscriptionFrom`](/speech/transcription/).
- **Text → audio file**: use
  [Basic speech synthesis](/recipes/basic-speech-synthesis/) or
  [`synthesize`](/speech/synthesis/).
- **LLM tokens → spoken answer**: use
  [Streaming synthesis](/recipes/streaming-synthesis/) or
  [`streamSynthesisFrom`](/speech/synthesis/).

For the full STT → LLM → TTS composition, start with
[Voice loop](/recipes/voice-loop/). It is the today-answer for a voice
assistant: live mic, turn queueing, stop-word interrupt, and streaming
playback.

## Two Tags, Same Idea

```ts
import { Transcriber } from "@effect-uai/core/Transcriber"
import { SpeechSynthesizer } from "@effect-uai/core/SpeechSynthesizer"
```

Provider choice is wiring. Every provider's `layer` registers itself
under its own typed tag (`OpenAITranscriber`, `ElevenLabsSynthesizer`,
…) _and_ the generic `Transcriber` / `SpeechSynthesizer`. Code that
yields the generic tag is portable; code that yields the typed tag
gets that provider's extended options.

This is the same seam [`LanguageModel`](/concepts/language-model/) and
[`EmbeddingModel`](/embeddings/) use. Switching providers is swapping a
Layer.

## The Shape

```ts
interface TranscriberService {
  readonly transcribe: (req: CommonTranscribeRequest) => Effect<TranscriptResult, AiError>
  readonly streamTranscriptionFrom: <E, R>(
    audioIn: Stream<Uint8Array, E, R>,
    req: CommonStreamTranscribeRequest,
  ) => Stream<TranscriptEvent, AiError | E, R>
}

interface SpeechSynthesizerService {
  readonly synthesize: (req: CommonSynthesizeRequest) => Effect<AudioBlob, AiError>
  readonly streamSynthesis: (req: CommonSynthesizeRequest) => Stream<AudioChunk, AiError>
  readonly streamSynthesisFrom: <E, R>(
    textIn: Stream<string, E, R>,
    req: CommonStreamSynthesizeRequest,
  ) => Stream<AudioChunk, AiError | E, R>
}
```

Top-level helpers mirror the service methods:

```ts
import { transcribe, streamTranscriptionFrom } from "@effect-uai/core/Transcriber"
import {
  synthesize,
  streamSynthesis,
  streamSynthesisFrom,
} from "@effect-uai/core/SpeechSynthesizer"
```

Sync helpers (`transcribe`, `synthesize`) only need the generic tag in
their `R`. Streaming helpers additionally need a capability marker —
see below.

## Capability markers

Streaming speech has real provider capability gaps. Capability markers
make those gaps visible at `Effect.provide`, not halfway through a
demo.

- **`SttStreaming`** — required for `streamTranscriptionFrom`. Shipped
  by `OpenAIRealtimeTranscriber`, `ElevenLabsTranscriber`,
  `InworldRealtimeTranscriber`. Not shipped by `OpenAITranscriber`
  (sync), `GeminiTranscriber` (sync, prompt-driven), `InworldTranscriber`.
- **`TtsIncrementalText`** — required for `streamSynthesisFrom` (text
  arrives as a `Stream<string>`, audio leaves as `Stream<AudioChunk>`,
  pacing tied to the upstream WS). Shipped by `ElevenLabsSynthesizer`
  and `InworldRealtimeSynthesizer`. Not shipped by `OpenAISynthesizer`
  (no incremental-text-in endpoint), `GeminiSynthesizer` (sync-only).

Calling a gated helper while only an unmarked Layer is in scope is a
type error at `Effect.provide`, not a runtime `Unsupported`.

## Provider matrix

| Provider | STT sync | STT streaming | TTS sync | TTS chunked | TTS incremental-text |
| -------- | -------- | ------------- | -------- | ----------- | -------------------- |
| OpenAI | ✓ | ✓ (`OpenAIRealtimeTranscriber`) | ✓ | ✓ | — |
| ElevenLabs | — | ✓ (Scribe v2 Realtime) | ✓ | ✓ | ✓ |
| Gemini | ✓ (prompt-driven) | — | ✓ | — | — |
| Inworld | ✓ | ✓ | ✓ | ✓ | ✓ |

Each provider's full surface — models, voice IDs, wire / auth notes —
lives on its page: [OpenAI](/speech/providers/openai/),
[ElevenLabs](/speech/providers/elevenlabs/),
[Gemini](/speech/providers/gemini/),
[Inworld](/speech/providers/inworld/).

## Next step

Build a voice assistant: [Voice loop](/recipes/voice-loop/) — STT, LLM,
and TTS streams composed as Effect fibers, with stop-word interrupt
and turn queueing.

Or start with one primitive in isolation:
[Basic transcription](/recipes/basic-transcription/) or
[Basic speech synthesis](/recipes/basic-speech-synthesis/).

## See also

- [Transcription](/speech/transcription/) — STT in depth.
- [Synthesis](/speech/synthesis/) — TTS in depth.
- [Realtime](/realtime/) — duplex voice / video sessions (planned).
- [Voice loop recipe](/recipes/voice-loop/) — the flagship composition.
