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

| Model | Duration | Output | Notes |
| --- | --- | --- | --- |
| `lyria-3-clip-preview` | Fixed 30 s | MP3 | Default; fastest |
| `lyria-3-pro-preview` | Up to ~2 min | MP3 or WAV | Slower, higher quality |

`LyriaModel` is a literal union with `(string & {})` tail — pass any
string for models the SDK hasn't been updated for.

## Request shape

```ts
type LyriaGenerateRequest = {
  readonly model: LyriaModel
  readonly prompts: string | ReadonlyArray<WeightedPrompt>
  readonly lyrics?: string // [Verse] / [Chorus] tags supported
  readonly bpm?: number // flattened into prompt text on sync API
  readonly scale?: string // flattened into prompt text on sync API
  readonly instrumental?: boolean
  readonly outputFormat?: AudioFormat // mp3 or wav
}
```

Lyria 3 **sync** has no structured weighted-prompt / BPM / scale field
on the public REST endpoint — `WeightedPrompt[]`, `bpm`, `scale`,
`instrumental` are flattened into the prompt text by the adapter
before the call. Lyria RealTime exposes these as structured updates
mid-session; that path will land when `MusicInteractiveSession` ships.

## Output

```ts
type MusicResult = AudioBlob & {
  readonly watermark?: { kind: string } // always set: { kind: "SynthID" }
}
```

Every Lyria output carries a SynthID watermark in the audio. The
adapter surfaces it via `result.watermark` so downstream code can
verify or attribute provenance.

## Wire / auth notes

Sync endpoint:
`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
with `generationConfig.responseModalities: ["AUDIO"]`. Response is
base64 MP3 (or WAV for `lyria-3-pro-preview` with `audio/wav` requested).

Same `GOOGLE_API_KEY` as the language-model and speech Gemini layers.

## Errors

Standard HTTP → `AiError` mapping. Lyria-specific:

| Request shape | Error |
| --- | --- |
| `model: "lyria-3-clip-preview"` with `durationSeconds` ≠ 30 | `AiError.InvalidRequest` |
| WAV requested on `lyria-3-clip-preview` | `AiError.Unsupported` (clip is MP3-only) |
| `streamGenerationFrom` call | Compile-time error (no marker) |

## See also

- [Music generation overview](/music-generation/) — the generic
  service tag and request shape.
- [Basic music generation](/recipes/basic-music-generation/) — the
  recipe with both simple and weighted variants.
