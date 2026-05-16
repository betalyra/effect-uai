---
title: Music generation
description: Prompt → music. One service tag, three modes, weighted prompts for blended influences.
---

A short text prompt can be enough for a usable clip.

Music generation is the audio sibling of image generation: describe the
thing you want, get media bytes back. The current implementation is
Google Lyria, but the service is shaped so other providers can hide
their own polling or streaming details behind the same calls.

**Scenario.** You need background music for a video, a quick demo
track, or a musical sketch. Start with a prompt like
`"Lo-fi piano with brushed drums, 70 bpm"`. Add weighted influences,
lyrics, BPM, or key hints only when you need more control.

## Three Modes

```ts
import { generate, streamGeneration, streamGenerationFrom } from "@effect-uai/core/MusicGenerator"
```

- **`generate`** — sync. Prompt in, full `MusicResult` (audio blob +
  optional `lyrics` / `sections` / `watermark`) out. Async / poll-based
  providers (Lyria 3 sync, Suno, Mureka) hide their poll loop inside
  the adapter — caller still sees a single `Effect`.
- **`streamGeneration`** — prompt in, `Stream<AudioChunk>` out.
  Providers without a native chunked endpoint emit a single chunk; bidi
  providers stream natively.
- **`streamGenerationFrom`** — bidirectional. A `Stream<MusicSessionInput>`
  pushes prompt blends, config deltas, and playback controls into the
  session; a `Stream<AudioChunk>` streams audio back. Gated by the
  `MusicInteractiveSession` capability marker.

Start with `generate`. Reach for the streaming shapes when a provider
can produce audio incrementally or when an interactive session needs to
change prompts while music is playing.

## The Shape

```ts
interface MusicGeneratorService {
  readonly generate: (req: CommonGenerateMusicRequest) => Effect<MusicResult, AiError>
  readonly streamGeneration: (req: CommonStreamGenerateMusicRequest) => Stream<AudioChunk, AiError>
  readonly streamGenerationFrom: <E, R>(
    input: Stream<MusicSessionInput, E, R>,
    req: CommonStreamGenerateMusicRequest,
  ) => Stream<AudioChunk, AiError | E, R>
}
```

## Prompt Shape

```ts
type CommonGenerateMusicRequest = {
  readonly model: string
  readonly prompts: string | ReadonlyArray<WeightedPrompt>
  readonly lyrics?: string // optionally with [Verse] / [Chorus] tags
  readonly durationSeconds?: number
  readonly bpm?: number
  readonly scale?: string // provider vocabulary, e.g. Lyria "C_MAJOR"
  readonly instrumental?: boolean
  readonly outputFormat?: AudioFormat
}

type WeightedPrompt = {
  readonly text: string
  readonly weight?: number // default 1.0
}
```

`prompts` can be one string or a weighted blend. `lyrics` can include
section tags such as `[Verse]` and `[Chorus]`. `bpm`, `scale`, and
`instrumental` are hints; each provider decides whether those are
structured wire fields or prompt text.

## What You Get Back

```ts
type MusicResult = AudioBlob & {
  readonly songId?: string
  readonly lyrics?: string
  readonly sections?: ReadonlyArray<{ label: string; startSeconds: number; endSeconds: number }>
  readonly watermark?: { kind: string }
}
```

`watermark` is always set for Lyria (SynthID). `lyrics` / `sections`
only when the model returned them.

## Capability Marker

**`MusicInteractiveSession`** gates `streamGenerationFrom`. Today no
provider Layer ships it; Lyria RealTime is the planned implementation.
Calling `streamGenerationFrom` against `@effect-uai/google/LyriaGenerator`
is a compile-time error until that lands.

This is the same phantom-marker pattern as
[`SttStreaming` / `TtsIncrementalText`](/speech/#capability-markers) —
provider capability gaps surface at `Effect.provide` typechecking, not
runtime.

## Provider matrix

| Provider     | Sync           | Chunked stream         | Bidi session                |
| ------------ | -------------- | ---------------------- | --------------------------- |
| Google Lyria | ✓ (clip + pro) | ✓ (single-chunk emul.) | — (planned: Lyria RealTime) |

The matrix is small today. Suno, Udio, Mureka, MiniMax, and Stable
Audio are candidates for follow-up phases; they fit the same
service-tag shape.

## Next step

[Basic music generation](/recipes/basic-music-generation/) — a simple
prompt and a weighted-prompt variant with lyrics + BPM hints, both
against Lyria 3.

## See also

- [Google Lyria provider](/music-generation/providers/gemini/) —
  models, request shape, watermark notes.
- [Speech](/speech/) — sibling capability for STT and TTS.
