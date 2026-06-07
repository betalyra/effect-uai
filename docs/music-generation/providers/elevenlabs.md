---
title: ElevenLabs Music
description: Sync and chunked-streaming music generation via Eleven Music. Free composition-plan generator, structured per-section lyrics + styles, optional C2PA signing.
---

ElevenLabs Music is exposed through `@effect-uai/elevenlabs`. Sync
generation and **real** chunked HTTP streaming; `streamGenerationFrom`
(bidi session updates) is a compile-time error against this Layer
(no bidi endpoint).

For ElevenLabs TTS see [Speech / ElevenLabs](/speech/providers/elevenlabs/).
This page covers **music** only.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/elevenlabs effect
```

## Layer

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as elevenlabsMusicLayer } from "@effect-uai/elevenlabs/ElevenLabsMusicGenerator"

const music = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY")
    return elevenlabsMusicLayer({ apiKey })
  }),
)

const mainLayer = music.pipe(Layer.provide(FetchHttpClient.layer))
```

`elevenlabsMusicLayer` registers two service tags from one underlying
implementation:

- **`ElevenLabsMusicGenerator`** — the typed tag. Yield this for the
  full provider surface (composition plan, `forceInstrumental`,
  `signWithC2pa`, `createCompositionPlan`).
- **`MusicGenerator`** — the generic tag. Yield this in
  provider-portable code.

Does **not** register `MusicInteractiveSession` — calling
`streamGenerationFrom` is a compile error against this Layer alone.

## Models

| Model      | Status                    | Notes                                                                 |
| ---------- | ------------------------- | --------------------------------------------------------------------- |
| `music_v1` | API default (May 2026)    | The model the API exposes today.                                      |
| `music_v2` | UI default; API in flight | ElevenLabs Music v2 launched 2026-05-26; `model_id` plumbing pending. |

`ElevenLabsMusicModel` is a literal union with `(string & {})` tail
so newer model IDs work as soon as ElevenLabs ships them.

## Two modes: prompt and composition plan

ElevenLabs Music has two mutually-exclusive input modes on the same
endpoints.

### Prompt mode

```ts
import { Duration } from "effect"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"

const result =
  yield *
  MusicGenerator.generate({
    model: "music_v1",
    prompt: "Lo-fi piano with brushed drums, 70 BPM, melancholic",
    duration: Duration.seconds(60),
    outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, bitRate: 128 },
  })

yield * writeFile("out.mp3", result.primary.audio.bytes)
```

Bucket-2 fields the Common request carries but ElevenLabs cannot
honor in prompt mode (`lyrics`) are dropped with a structured
`Effect.logWarning` — embed lyrics in your prompt yourself, or use
the composition plan below.

### Composition-plan mode

A `MusicPrompt` plan structures the song into named sections with
per-section lyrics, positive / negative style hints, and duration.
Reach for it when the prompt mode's single-string surface isn't
expressive enough.

```ts
import { Duration } from "effect"
import * as ElevenLabsMusicGenerator from "@effect-uai/elevenlabs/ElevenLabsMusicGenerator"

const result =
  yield *
  ElevenLabsMusicGenerator.ElevenLabsMusicGenerator.use((s) =>
    s.generate({
      model: "music_v1",
      prompt: "", // must be empty when compositionPlan is set
      compositionPlan: {
        positiveGlobalStyles: ["lo-fi", "warm", "vintage tape"],
        negativeGlobalStyles: ["distorted", "harsh"],
        sections: [
          {
            sectionName: "Intro",
            positiveLocalStyles: ["solo piano", "soft"],
            negativeLocalStyles: [],
            duration: Duration.seconds(12),
            lines: [],
          },
          {
            sectionName: "Verse",
            positiveLocalStyles: ["brushed drums enter", "upright bass"],
            negativeLocalStyles: [],
            duration: Duration.seconds(24),
            lines: ["A late train hums beneath the city"],
          },
        ],
      },
      forceInstrumental: false,
      signWithC2pa: true,
    }),
  )
```

`prompt` and `compositionPlan` are mutually exclusive on the wire;
the adapter rejects with `AiError.InvalidRequest` if both are set.
`duration` is rejected the same way when `compositionPlan` is set —
each section carries its own `duration`.

### Free composition-plan generator

Turn a prompt into a structured plan you can then edit and feed back
into `generate`:

```ts
const plan =
  yield *
  ElevenLabsMusicGenerator.ElevenLabsMusicGenerator.use((s) =>
    s.createCompositionPlan({
      prompt: "Lo-fi piano with brushed drums, intro then verse, 60 s",
      duration: Duration.seconds(60),
    }),
  )

// Mutate or augment plan, then:
const result =
  yield *
  MusicGenerator.generate({
    /* … */ compositionPlan: plan,
  })
```

The plan endpoint is free (rate-limited only, no credit cost). Use it
as a starting point when prompt-only output isn't structured enough.

## Streaming output

ElevenLabs ships native chunked HTTP streaming via `POST /v1/music/stream`.

```ts
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"
import { Stream } from "effect"

const chunks = MusicGenerator.streamGeneration({
  model: "music_v1",
  prompt: "uplifting orchestral build, 90 BPM",
  duration: Duration.seconds(45),
})

// Stream<AudioChunk> straight to a sink:
yield * Stream.run(chunks, fileSink)
```

Each `AudioChunk` is raw bytes in your requested `output_format`
(default mp3 44.1 kHz 128 kbps). No fake single-chunk fallback — the
adapter forwards the SSE-encoded byte stream as-is.

## Request shape (provider-typed)

```ts
type ElevenLabsMusicGenerateRequest = Omit<CommonGenerateMusicRequest, "model"> & {
  readonly model?: ElevenLabsMusicModel // default "music_v1"
  readonly compositionPlan?: ElevenLabsCompositionPlan
  readonly forceInstrumental?: boolean
  readonly signWithC2pa?: boolean // MP3 output only
  readonly respectSectionsDurations?: boolean // composition-plan mode only
}
```

## Output

```ts
type MusicResult = {
  readonly audio: AudioBlob
  readonly provider?: "elevenlabs-music"
  readonly songId?: string // ElevenLabs song_id, when returned in headers
  readonly watermark?: Watermark // "c2pa" when signWithC2pa: true
}
```

Returned as `GenerateResult` (one variant; `primary === variants[0]`).
C2PA Content Credentials are opt-in via `signWithC2pa: true` and
apply to MP3 output only. Surfaced as `result.primary.watermark === "c2pa"`.

## Output formats

`outputFormat` is encoded as ElevenLabs's `?output_format=` slug:

| Container | Encoding  | Sample rates                                               | Bitrates (mp3 / opus)    |
| --------- | --------- | ---------------------------------------------------------- | ------------------------ |
| mp3       | mp3       | 22050, 24000, 44100                                        | 32, 48, 64, 96, 128, 192 |
| opus      | opus      | 48000                                                      | 32, 64, 96, 128, 192     |
| wav       | pcm_s16le | 48000                                                      | n/a                      |
| raw       | pcm_s16le | any (8000 / 16000 / 22050 / 24000 / 32000 / 44100 / 48000) | n/a                      |
| raw       | pcm_mulaw | 8000                                                       | n/a                      |
| raw       | pcm_alaw  | 8000                                                       | n/a                      |

Unencodable formats fail `AiError.Unsupported` at the adapter,
matching the rest of the ElevenLabs codec surface. Tier gates apply
(e.g. `mp3_44100_192` requires Creator+).

## Wire / auth notes

| Endpoint                | Use                                              |
| ----------------------- | ------------------------------------------------ |
| `POST /v1/music`        | Sync. Binary audio response in requested format. |
| `POST /v1/music/stream` | Chunked HTTP stream. Same body as sync.          |
| `POST /v1/music/plan`   | Free composition-plan generator. Returns JSON.   |

Auth: `xi-api-key` header — same key as TTS / STT. Regional bases
honored via the `region` field on `Config` (default / `eu` / `in`),
shared with the rest of `@effect-uai/elevenlabs`.

## Errors

Standard HTTP → `AiError` mapping. ElevenLabs-music-specific:

| Request shape                            | Error                                     |
| ---------------------------------------- | ----------------------------------------- |
| `prompt` non-empty AND `compositionPlan` | `AiError.InvalidRequest` (mutually excl.) |
| `duration` set AND `compositionPlan` set | `AiError.InvalidRequest`                  |
| Output format the codec can't encode     | `AiError.Unsupported`                     |
| 422 validation error from the API        | `AiError.InvalidRequest` (with raw body)  |
| `streamGenerationFrom` call              | Compile-time error (no marker, no bidi)   |

## See also

- [Music generation overview](/music-generation/) — the generic
  service tag and request shape.
- [Google Lyria](/music-generation/providers/gemini/) — the other
  music provider in tree today.
- [Basic music generation](/recipes/basic-music-generation/) — the
  multi-provider recipe with `--provider=google|elevenlabs`.
- [Speech / ElevenLabs](/speech/providers/elevenlabs/) — TTS + STT
  on the same package.
