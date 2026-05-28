---
title: Google Lyria
description: Sync music generation via Lyria 3 over the Gemini REST API. 30 s MP3 clips or longer pro renders with MP3 / WAV.
---

Lyria 3 is Google's music model exposed through `@effect-uai/google`.
Sync generation only — `streamGeneration` falls back to a single
chunk; `streamGenerationFrom` (bidi session updates) is a compile-time
error against this Layer until Lyria RealTime lands.

For language-model use of Gemini see [Providers / Gemini](/providers/gemini/).
For speech (TTS / STT) see [Speech / Gemini](/speech/providers/gemini/).
This page covers **music** only.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

## Layer

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as lyriaLayer } from "@effect-uai/google/LyriaGenerator"

const lyria = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return lyriaLayer({ apiKey })
  }),
)

const mainLayer = lyria.pipe(Layer.provide(FetchHttpClient.layer))
```

`lyriaLayer` registers two service tags from one underlying
implementation:

- **`LyriaGenerator`** — the typed tag. Yield this for autocomplete on
  `model: LyriaModel`.
- **`MusicGenerator`** — the generic tag. Yield this in
  provider-portable code.

Does **not** register `MusicInteractiveSession` — calling
`streamGenerationFrom` is a compile error.

## Models

| Model                  | Duration     | Output     | Notes                  |
| ---------------------- | ------------ | ---------- | ---------------------- |
| `lyria-3-clip-preview` | Fixed 30 s   | MP3        | Default; fastest       |
| `lyria-3-pro-preview`  | Up to ~2 min | MP3 or WAV | Slower, higher quality |

`LyriaModel` is a literal union with `(string & {})` tail — pass any
string for models the SDK hasn't been updated for.

## Request shape

```ts
type LyriaGenerateRequest = {
  readonly model: LyriaModel
  readonly prompt: string                  // single string; forwarded verbatim
  readonly lyrics?: string                 // dropped with a logged warning
  readonly duration?: Duration.Duration    // dropped with a logged warning
  readonly seed?: number                   // dropped with a logged warning
  readonly outputFormat?: AudioFormat      // mp3 or wav (pro only)
}
```

Lyria 3 sync's wire (`generateContent`) has no structured field for
`lyrics`, `duration`, or `seed`. The 0.7 adapter does **not** splice
those into your prompt text on your behalf — prompt construction is
the developer's job. Setting them on the request logs a structured
[`CapabilityWarning`](https://github.com/betalyra/effect-uai/blob/main/packages/core/src/capabilities/Capabilities.ts)
and proceeds with the prompt unchanged. If you want vocals to follow
specific lyrics, embed them in your `prompt` with `[Verse]` /
`[Chorus]` tags.

Provider-typed extras that exist on the Lyria RealTime surface
(weighted prompts, BPM as a structured enum, scale enum,
density / brightness / mute-stems) will land with that adapter under
its own service tag.

## Output

```ts
type MusicResult = {
  readonly audio: AudioBlob
  readonly provider?: "lyria"
  readonly lyrics?: string                 // text part when Lyria returned one
  readonly watermark?: Watermark           // always "synthid"
}
```

Returned as `GenerateResult` with one variant (Lyria 3 sync returns
exactly one track per call; `primary === variants[0]`). Every Lyria
output carries a SynthID watermark in the audio. The adapter surfaces
it via `result.primary.watermark` so downstream code can verify or
attribute provenance.

## Wire / auth notes

Sync endpoint:
`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
with `generationConfig.responseModalities: ["AUDIO"]`. Response is
base64 MP3 (or WAV for `lyria-3-pro-preview` with `audio/wav` requested).

Same `GOOGLE_API_KEY` as the language-model and speech Gemini layers.

## Errors

Standard HTTP → `AiError` mapping. Lyria-specific:

| Request shape                              | Error                                       |
| ------------------------------------------ | ------------------------------------------- |
| WAV requested on `lyria-3-clip-preview`    | `AiError.Unsupported` (clip is MP3-only)    |
| Output container ≠ mp3 / wav               | `AiError.Unsupported`                       |
| Empty audio part in the response           | `AiError.GenerationFailed` (likely a prompt-filter rejection — Lyria filters artist names and copyrighted lyrics) |
| `streamGenerationFrom` call                | Compile-time error (no marker)              |

## See also

- [Music generation overview](/music-generation/) — the generic
  service tag and request shape.
- [ElevenLabs Music](/music-generation/providers/elevenlabs/) — the
  other music provider in tree (full songs, composition plans, native
  chunked streaming).
- [Basic music generation](/recipes/basic-music-generation/) — the
  multi-provider recipe with `--provider=google|elevenlabs`.
