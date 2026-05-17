---
title: Google Gemini
description: Sync STT (prompt-driven) and sync TTS. No streaming markers — for streaming, pair with another provider.
---

The Gemini speech surface is sync-only and rides on the same
`:generateContent` endpoint the language-model package uses. Useful
when you already have a Gemini key and don't need streaming.

For language-model use of Gemini (chat, tools, thinking budget) see
[Providers / Gemini](/providers/gemini/). For music generation with
Lyria see [Music generation / Lyria](/music-generation/providers/gemini/).
This page covers only **speech**.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

## Layers

| Layer                                  | Registers                                 | Capability markers                         |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| `@effect-uai/google/GeminiTranscriber` | `GeminiTranscriber` + `Transcriber`       | — (sync only)                              |
| `@effect-uai/google/GeminiSynthesizer` | `GeminiSynthesizer` + `SpeechSynthesizer` | — (sync only; no `streamSynthesis` either) |

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as transcriberLayer } from "@effect-uai/google/GeminiTranscriber"
import { layer as synthLayer } from "@effect-uai/google/GeminiSynthesizer"

const gemini = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return Layer.mergeAll(transcriberLayer({ apiKey }), synthLayer({ apiKey }))
  }),
)

const mainLayer = gemini.pipe(Layer.provide(FetchHttpClient.layer))
```

Neither layer ships `SttStreaming` or `TtsIncrementalText`. Calling
`streamTranscriptionFrom` or `streamSynthesisFrom` against this Layer
is a compile-time error — for streaming, use OpenAI Realtime,
ElevenLabs, or Inworld.

## Models

### STT (audio understanding)

Gemini's "transcription" isn't a dedicated endpoint — it's the
multimodal model receiving an audio part plus the prompt "Transcribe
verbatim." Any model that accepts the audio modality works:
`gemini-3-flash-preview`, `gemini-3.1-pro-preview`,
`gemini-3.1-flash-lite-preview`, `gemini-2.5-flash`, `gemini-2.5-pro`.

Limits:

- **No word timestamps** — `wordTimestamps: true` fails with
  `AiError.Unsupported`. The model can emit `MM:SS` timestamps inside
  the text if you ask in the prompt, but they're unstructured.
- **No diarization** — `diarization: true` fails with `Unsupported`.
- **No language forcing** — autodetected; `language` hint accepted but
  not enforced.
- **20 MB inline-data ceiling** — use the Files API for longer audio
  (not yet wired in this adapter).

Audio formats accepted: `audio/wav`, `audio/mp3`, `audio/aiff`,
`audio/aac`, `audio/ogg`, `audio/flac`.

### TTS

| Model                          | Notes                   |
| ------------------------------ | ----------------------- |
| `gemini-2.5-flash-preview-tts` | Steerable preview model |
| `gemini-2.5-pro-preview-tts`   | Higher quality, slower  |
| `gemini-3.1-flash-tts-preview` | Newer flash preview     |

30 prebuilt voices — `Kore`, `Puck`, `Zephyr`, `Enceladus`, `Charon`,
`Aoede`, `Leda`, `Orus`, `Callirrhoe`, etc. (full list in
`@effect-uai/google` models.ts). `GeminiVoiceName` is a literal-only
union with no `(string & {})` escape — there's no cloning path on this
surface.

Output is PCM s16le at **24 kHz**, returned wrapped in a WAV RIFF
header by the adapter (so it drops into an `<audio>` tag directly).

## Request shape

```ts
// STT
type GeminiTranscribeRequest = {
  readonly model: GeminiSttModel
  readonly audio: AudioSource
  readonly language?: string // hint only — Gemini autodetects
  readonly prompt?: string // appended to the "transcribe verbatim" instruction
}

// TTS
type GeminiSynthesizeRequest = {
  readonly model: GeminiTtsModel
  readonly voiceId: GeminiVoiceName // literal-only — no cloning
  readonly text: string
  readonly outputFormat?: AudioFormat // ignored — always wav/pcm 24 kHz
  readonly styleInstructions?: string // prompt-level prosody direction
}
```

`styleInstructions` is free-form natural language —
`"say this in a warm, conversational tone"`,
`"emphasize the second sentence"`. Combine with inline prosody tags
in the text (`[whispers]`, `[shouting]`) for finer control. No SSML,
no `speed` / `pitch` knobs.

## Wire / auth notes

Both endpoints are
`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
with `generationConfig.responseModalities` set to `["AUDIO"]` for TTS,
or with audio supplied as `inlineData` for STT. The same `apiKey` works
for everything.

## Errors

Standard HTTP → `AiError` mapping. Additionally:

| Request shape                  | Error                    |
| ------------------------------ | ------------------------ |
| `wordTimestamps: true`         | `AiError.Unsupported`    |
| `diarization: true`            | `AiError.Unsupported`    |
| Audio larger than 20 MB inline | `AiError.InvalidRequest` |

## See also

- [Speech overview](/speech/) — capability markers and the wider
  provider matrix.
- [Basic transcription](/recipes/basic-transcription/) — Gemini and
  OpenAI side-by-side; the recipe skips the verbose-mode variant
  when `--provider gemini` is set.
- [Basic speech synthesis](/recipes/basic-speech-synthesis/) —
  one-shot Gemini TTS at 24 kHz WAV.
