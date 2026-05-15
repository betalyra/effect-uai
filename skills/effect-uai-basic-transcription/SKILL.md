---
name: effect-uai-basic-transcription
description: Use when the user wants to transcribe a finished audio file with effect-uai — voice notes, meeting recordings, podcast clips, or batch STT. Covers the generic Transcriber service, provider-swappable sync transcription, OpenAI Whisper word timestamps, and choosing OpenAI, Gemini, ElevenLabs, or Inworld layers for file transcription.
license: MIT
---

# effect-uai basic-transcription

Finished audio in, text out. Use `Transcriber.transcribe` when the
whole audio asset already exists.

Reach for this when the user says any of:

- "Transcribe this audio file / meeting / voice note"
- "I need word timestamps from audio"
- "Use OpenAI or Gemini for speech-to-text"

## Pattern

```ts
import type { AudioSource } from "@effect-uai/core/Audio"
import * as Transcriber from "@effect-uai/core/Transcriber"

export const transcribeFast = (audio: AudioSource) =>
  Transcriber.transcribe({
    audio,
    model: "gpt-4o-transcribe",
    language: "en",
  })
```

`audio` can be bytes, base64, or URL depending on provider support.
The recipe's runner reads a file into bytes; browser apps can pass
bytes from a `File`.

## Word timestamps

OpenAI `whisper-1` is the timestamp path:

```ts
export const transcribeVerbose = (audio: AudioSource) =>
  Transcriber.transcribe({
    audio,
    model: "whisper-1",
    wordTimestamps: true,
  })
```

`result.text` is always the transcript. `result.words` only exists when
the provider/model supports `wordTimestamps`. Gemini's prompt-driven
STT returns text only; asking for word timestamps fails with
`AiError.Unsupported`.

## Provider switching

Keep provider choice in the runner:

```ts
import { Match } from "effect"

export type Provider = "openai" | "gemini" | "elevenlabs" | "inworld"

const fastModelFor = Match.type<Provider>().pipe(
  Match.when("openai", () => "gpt-4o-transcribe"),
  Match.when("gemini", () => "gemini-2.5-flash"),
  Match.when("elevenlabs", () => "scribe_v2"),
  Match.when("inworld", () => "inworld/inworld-stt-1"),
  Match.exhaustive,
)
```

Add a provider by extending the provider union, model match, and
runner `layerFor`. The recipe body should keep yielding the generic
`Transcriber` tag.

## Anti-patterns

- **Don't use live mic APIs for finished files.** Use `transcribe` for
  batch/file work; use `streamTranscriptionFrom` only when audio
  arrives over time.
- **Don't assume timestamps are portable.** Check provider/model
  support before setting `wordTimestamps: true`.
- **Don't put provider SDK calls in the recipe body.** Provider choice
  belongs at the Layer boundary.

## See also

- Recipe source: `recipes/basic-transcription/index.ts`
- For live captions: `effect-uai-streaming-transcription`
- For voice assistants: `effect-uai-voice-loop`
