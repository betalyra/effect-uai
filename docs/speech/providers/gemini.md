---
title: Google Gemini
description: Sync TTS only. No streaming markers. For streaming, or for transcription, pair with another provider.
---

The Gemini speech surface is sync TTS only and rides on the same
`:generateContent` endpoint the language-model package uses. Useful when
you already have a Gemini key and don't need streaming.

> **Removed in 0.7:** `GeminiTranscriber` (sync STT) is gone. It rode on
> `:generateContent` with a "transcribe verbatim" prompt rather than a
> dedicated transcription endpoint, so it had no native word timestamps
> or diarization. For transcription use `OpenAITranscriber`,
> `ElevenLabsTranscriber`, or `InworldTranscriber`. See
> [Migrating to 0.7](/migrations/v0-7/).

For language-model use of Gemini (chat, tools, thinking budget) see
[Providers / Gemini](/providers/gemini/). For music generation with
Lyria see [Music generation / Lyria](/music-generation/providers/gemini/).
This page covers only **speech synthesis**.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

## Layers

| Layer                                  | Registers                                 | Capability markers                         |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| `@effect-uai/google/GeminiSynthesizer` | `GeminiSynthesizer` + `SpeechSynthesizer` | — (sync only; no `streamSynthesis` either) |

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as synthLayer } from "@effect-uai/google/GeminiSynthesizer"

const gemini = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return synthLayer({ apiKey })
  }),
)

const mainLayer = gemini.pipe(Layer.provide(FetchHttpClient.layer))
```

The layer does not ship `TtsIncrementalText`. Calling
`streamSynthesisFrom` against it is a compile-time error. For streaming
TTS, use ElevenLabs or Inworld.

## Models

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

Output is PCM s16le at **24 kHz**, returned wrapped in a WAV RIFF header
by the adapter (so it drops into an `<audio>` tag directly).

## Request shape

```ts
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
`"emphasize the second sentence"`. Combine with inline prosody tags in
the text (`[whispers]`, `[shouting]`) for finer control. No SSML, no
`speed` / `pitch` knobs. `speed` and `languageCode` on the common request
are `warnDropped` (Gemini has no wire field for either).

`pronunciations` fail `AiError.Unsupported`: Gemini TTS has no phoneme
field. Use Inworld for inline IPA, or ElevenLabs pronunciation
dictionaries.

## Wire / auth notes

The endpoint is
`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
with `generationConfig.responseModalities` set to `["AUDIO"]`.

## See also

- [Speech overview](/speech/) — capability markers and the wider
  provider matrix.
- [Basic speech synthesis](/recipes/basic-speech-synthesis/) — one-shot
  Gemini TTS at 24 kHz WAV.
