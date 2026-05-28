---
title: Music generation
description: Prompt → music. One service tag, three modes. Two providers in tree (Google Lyria, ElevenLabs Music); cross-provider Common request trimmed to what every provider honors structurally.
---

A short text prompt can be enough for a usable clip.

Music generation is the audio sibling of image generation: describe
the thing you want, get media bytes back. Two providers ship today —
**Google Lyria** and **ElevenLabs Music** — behind the same
`MusicGenerator` service tag, so swapping providers is a Layer swap.

**Scenario.** You need background music for a video, a quick demo
track, or a musical sketch. Start with a prompt like
`"Lo-fi piano with brushed drums, 70 BPM"`. Provider-specific knobs
(BPM as a structured field, weighted blends, composition plans,
inpainting) live on each provider's typed surface.

## Three Modes

```ts
import { generate, streamGeneration, streamGenerationFrom } from "@effect-uai/core/MusicGenerator"
```

- **`generate`** — sync. Prompt in, full `GenerateResult` (`primary`
  plus `variants[]`) out. Async / poll-based providers hide their
  poll loop inside the adapter; caller still sees a single `Effect`.
- **`streamGeneration`** — prompt in, `Stream<AudioChunk>` out.
  Providers without a native chunked endpoint emit a single chunk
  (Lyria); providers with one stream natively (ElevenLabs).
- **`streamGenerationFrom`** — bidirectional. A
  `Stream<MusicSessionInput>` (prompts + playback control) flows in;
  a `Stream<MusicStreamEvent>` (audio chunks + in-band warnings)
  flows out. Gated by the `MusicInteractiveSession` capability marker.

Start with `generate`. Reach for `streamGeneration` when you want
audio to start playing before the full track lands. Reach for
`streamGenerationFrom` when you need to push prompt changes mid-track
(only Lyria RealTime when that adapter lands).

## The shape

```ts
interface MusicGeneratorService {
  readonly generate: (req: CommonGenerateMusicRequest) => Effect<GenerateResult, AiError>
  readonly streamGeneration: (req: CommonStreamGenerateMusicRequest) => Stream<AudioChunk, AiError>
  readonly streamGenerationFrom: <E, R>(
    input: Stream<MusicSessionInput, E, R>,
    req: CommonStreamGenerateMusicRequest,
  ) => Stream<MusicStreamEvent, AiError | E, R>
}
```

## Common request shape

```ts
import type { Duration } from "effect"

type CommonGenerateMusicRequest = {
  readonly model: string
  readonly prompt: string                  // single string; no client-side construction
  readonly lyrics?: string                 // routed to a wire field when the provider has one
  readonly duration?: Duration.Duration    // hint vs hard limit, per provider
  readonly seed?: number                   // tuning hint; bucket 3, silently ignored where unsupported
  readonly outputFormat?: AudioFormat
}
```

The Common request is deliberately trimmed to fields the majority of
music providers honor structurally. Provider-specific extras live on
each provider's typed request:

- Weighted-prompt blends (`WeightedPrompt[]`): Lyria RealTime,
  Riffusion compose.
- Structured BPM / scale / mute-stems: Lyria RealTime only.
- `instrumental` toggle (`force_instrumental`-style): ElevenLabs,
  MiniMax, Suno, Tencent.
- Composition plans (structured per-section lyrics + styles):
  ElevenLabs `compositionPlan`, Tencent via lyric labels.
- C2PA signing: ElevenLabs `signWithC2pa`.

If you ask for one of these via the Common surface against a
provider that can't honor it (e.g. `lyrics` on Lyria 3 sync), the
adapter logs a structured
[`CapabilityWarning`](https://github.com/betalyra/effect-uai/blob/main/packages/core/src/capabilities/Capabilities.ts)
via `Effect.logWarning` rather than silently rewriting your prompt.
Reach for the provider-typed surface (`LyriaGenerator`,
`ElevenLabsMusicGenerator`) when you want a wire field that exists
on exactly one provider.

## What you get back

```ts
type GenerateResult = {
  readonly primary: MusicResult
  readonly variants: ReadonlyArray<MusicResult>  // length ≥ 1
}

type MusicResult = {
  readonly audio: AudioBlob
  readonly provider?: string
  readonly songId?: string
  readonly lyrics?: string
  readonly sections?: ReadonlyArray<MusicSection>
  readonly watermark?: Watermark  // "synthid" | "c2pa" | (string & {})
}
```

`primary === variants[0]`. Most providers return exactly one track
per call. Suno and Mureka always return two; `variants` ensures the
second isn't dropped. Construct in your own adapter with
`singleVariant(result)`.

`MusicResult` composes `AudioBlob` rather than extending it — pass
`result.primary.audio` to anything that takes an `AudioBlob` without
spreading.

`watermark` is bare string-union: `"synthid"` for Lyria (always set,
SynthID is mandatory) and `"c2pa"` for ElevenLabs when
`signWithC2pa: true` (opt-in, MP3 output only).

## Session input

For bidirectional sessions (`streamGenerationFrom`), the cross-provider
input union covers the actions that converge across interactive-media
protocols:

```ts
type MusicSessionInput =
  | { readonly _tag: "prompts"; readonly prompts: ReadonlyArray<WeightedPrompt> }
  | { readonly _tag: "control"; readonly action: "play" | "pause" | "stop" | "reset" }
```

Provider-typed services widen this with their own `config` variant
for model-specific knobs — for example
`LyriaRealtimeSessionInput = MusicSessionInput | { _tag: "config"; config: LyriaRealtimeConfig }`
adds Lyria's density / brightness / mute-stems / BPM / scale knobs.

## Stream events

```ts
type MusicStreamEvent =
  | { readonly _tag: "audio"; readonly chunk: AudioChunk }
  | { readonly _tag: "warning"; readonly message: string }
  | { readonly _tag: "filteredPrompt"; readonly prompt: string; readonly reason: string }
```

In-band events alongside audio bytes — Lyria RealTime emits
`filteredPrompt` and `warning` server-side messages that flow on the
same stream rather than to a side-channel log. Filter with
`isAudioEvent` if you only want chunks.

## Capability marker

**`MusicInteractiveSession`** gates `streamGenerationFrom`. Today no
provider Layer in tree ships it; Lyria RealTime is the planned
implementation. Calling `streamGenerationFrom` against
`@effect-uai/google/LyriaGenerator` or
`@effect-uai/elevenlabs/ElevenLabsMusicGenerator` is a compile-time
error until that lands.

Same phantom-marker pattern as
[`SttStreaming` / `TtsIncrementalText`](/speech/#capability-markers).

## Provider matrix

| Provider                                                                | Sync         | Chunked stream          | Bidi session                |
| ----------------------------------------------------------------------- | ------------ | ----------------------- | --------------------------- |
| [Google Lyria](/music-generation/providers/gemini/)                     | ✓ (clip+pro) | ✓ (single-chunk emul.)  | — (planned: Lyria RealTime) |
| [ElevenLabs Music](/music-generation/providers/elevenlabs/)             | ✓            | ✓ (native HTTP chunked) | —                           |

Both providers also expose typed-surface extras (`LyriaGenerator`,
`ElevenLabsMusicGenerator`) for provider-specific wire fields the
Common request doesn't carry. Suno, Mureka, MiniMax, Stable Audio,
MusicGen, and Tencent are candidates for follow-up phases; they fit
the same service-tag shape.

## Next step

[Basic music generation](/recipes/basic-music-generation/) — the
multi-provider recipe with `--provider=google|elevenlabs` dispatch.

## See also

- [Google Lyria provider](/music-generation/providers/gemini/) —
  models, request shape, watermark notes.
- [ElevenLabs Music provider](/music-generation/providers/elevenlabs/) —
  composition plans, C2PA, free plan-generator endpoint.
- [Speech](/speech/) — sibling capability for STT and TTS.
- [Migrating to 0.7](/migrations/v0-7/) — the cross-provider trim
  and the new ElevenLabs adapter.
