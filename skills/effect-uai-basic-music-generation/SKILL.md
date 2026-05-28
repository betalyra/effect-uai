---
name: effect-uai-basic-music-generation
description: Use when the user wants to generate music with effect-uai — prompt to audio, background music, song drafts, Lyria 3 clips, ElevenLabs Music tracks, composition plans, C2PA / SynthID watermark handling. Covers MusicGenerator.generate, GenerateResult variants, both provider Layers (Google Lyria, ElevenLabs), and when to reach for provider-typed extras.
license: MIT
---

# effect-uai basic-music-generation

Prompt in, music bytes out. Use `MusicGenerator.generate` for short
background clips, song sketches, or demos. Two providers ship today
behind the same service tag: **Google Lyria** (30 s clip) and
**ElevenLabs Music** (full song up to 5 min).

Reach for this when the user says any of:

- "Generate music / background audio from a prompt"
- "Use Lyria with effect-uai"
- "Use ElevenLabs Music with effect-uai"
- "Generate a structured song with sections / lyrics"
- "Compare two providers on the same prompt"

## The shape (0.7)

```ts
import type { Duration } from "effect"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"

type CommonGenerateMusicRequest = {
  readonly model: string
  readonly prompt: string                  // single string only; no client-side construction
  readonly lyrics?: string                 // routed to a wire field where the provider has one
  readonly duration?: Duration.Duration    // hint vs hard limit, per provider
  readonly seed?: number                   // silently ignored where the provider doesn't expose one
  readonly outputFormat?: AudioFormat
}

type GenerateResult = {
  readonly primary: MusicResult            // convenience; equals variants[0]
  readonly variants: ReadonlyArray<MusicResult>  // Suno / Mureka return 2; others return 1
}

type MusicResult = {
  readonly audio: AudioBlob                // composition, not extension
  readonly provider?: string
  readonly songId?: string
  readonly lyrics?: string
  readonly sections?: ReadonlyArray<MusicSection>
  readonly watermark?: Watermark           // "synthid" | "c2pa" | (string & {})
}
```

`MusicGenerator.generate` returns `GenerateResult`, not `MusicResult`
directly. Reach into `result.primary.audio.bytes` for the bytes; loop
over `result.variants` when you want to handle multi-track providers
correctly.

## Provider-agnostic call (the common case)

```ts
import { Duration } from "effect"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"

export const generate = MusicGenerator.generate({
  model: "music_v1",   // or "lyria-3-clip-preview" for Google
  prompt: "Lo-fi piano with brushed drums, 70 BPM, melancholic",
  duration: Duration.seconds(30),
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
})
```

Then provide either Layer:

```ts
import { layer as lyriaLayer } from "@effect-uai/google/LyriaGenerator"
import { layer as elevenlabsMusicLayer } from "@effect-uai/elevenlabs/ElevenLabsMusicGenerator"
```

Both register the generic `MusicGenerator` tag; the recipe body
doesn't care which one you provided.

## What's NOT on the Common request

Removed in 0.7 because they didn't earn cross-provider weight:

| Removed         | Reach for                                                         |
| --------------- | ----------------------------------------------------------------- |
| `bpm`, `scale`  | Mention in your prompt text, or the typed Lyria RealTime surface. |
| `WeightedPrompt[]` blend | Lyria RealTime's `LyriaRealtimeSessionInput.prompts`.     |
| `instrumental`  | `ElevenLabsMusicGenerateRequest.forceInstrumental`, equivalent provider-typed field. |

Setting `lyrics` on the Common request against Lyria 3 sync (which
has no wire field for lyrics) logs a structured `CapabilityWarning`
via `Effect.logWarning` rather than silently splicing into your
prompt. **Never** construct prompts on the developer's behalf — pass
the user's prompt to the provider verbatim.

## Provider extras — reach for the typed service

### ElevenLabs composition plan

When the single-prompt surface isn't enough, ElevenLabs's typed
service accepts a structured `MusicPrompt` with per-section lyrics,
positive / negative styles, and durations:

```ts
import { Duration } from "effect"
import * as ElevenLabsMusicGenerator from "@effect-uai/elevenlabs/ElevenLabsMusicGenerator"

const result = yield* ElevenLabsMusicGenerator.ElevenLabsMusicGenerator.use((s) =>
  s.generate({
    model: "music_v1",
    prompt: "",   // must be empty when compositionPlan is set
    compositionPlan: {
      positiveGlobalStyles: ["lo-fi", "warm"],
      negativeGlobalStyles: ["distorted"],
      sections: [
        {
          sectionName: "Verse",
          positiveLocalStyles: ["brushed drums", "upright bass"],
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

`prompt` and `compositionPlan` are mutually exclusive; setting both
fails `AiError.InvalidRequest`. Same for `duration` + `compositionPlan`
(sections carry their own duration).

The free `createCompositionPlan(...)` helper turns a prompt into a
plan you can edit and feed back into `generate`. Rate-limited, no
credit cost.

### Lyria 3 — no structured knobs

Lyria 3 (Gemini) sync has no wire fields for tempo, key, instrumental,
lyrics, duration, or seed. The typed `LyriaGenerateRequest` is
basically the Common request with `model: LyriaModel`. Tempo / key /
vocal direction goes in your prompt text. Lyria RealTime (planned)
will land structured knobs under its own service tag.

## Multi-provider recipe

`recipes/basic-music-generation/run-node.ts` dispatches:

```sh
GOOGLE_API_KEY=...     pnpm tsx recipes/basic-music-generation/run-node.ts --provider=google
ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts --provider=elevenlabs
```

Writes `out-google.mp3` / `out-elevenlabs.mp3`. The body yields the
generic `MusicGenerator`; the runner picks the Layer.

## Streaming

```ts
const audio = MusicGenerator.streamGeneration({
  model: "music_v1",
  prompt: "uplifting orchestral build, 90 BPM",
})
```

- **Lyria 3**: emits a single chunk after the sync call lands (fake
  streaming, first-class but no first-byte savings).
- **ElevenLabs**: native chunked HTTP via `POST /v1/music/stream`.

## Bidi sessions

```ts
const events: Stream<MusicStreamEvent> = inputs.pipe(
  MusicGenerator.streamGenerationFrom({ model: "...", prompt: "" }),
)
```

Gated by the `MusicInteractiveSession` capability marker. No provider
in tree ships it today; Lyria RealTime is the planned implementation.
Calling against Lyria 3 or ElevenLabs Music Layer alone is a
compile-time error.

Output is `Stream<MusicStreamEvent>`: `audio` chunks alongside in-band
`warning` and `filteredPrompt` events from the model.

## Anti-patterns

- **Don't construct prompts on the developer's behalf.** No splicing
  `bpm`/`scale`/`lyrics` into the prompt text. If the provider has a
  wire field, route to it; otherwise warn-and-drop via
  `Capabilities.warnDropped` and forward the user's prompt verbatim.
- **Don't reach for `result.bytes`.** The 0.7 shape is `result.audio.bytes`.
  `MusicResult` composes `AudioBlob`, doesn't extend it.
- **Don't assume `generate` returns one track.** It returns
  `GenerateResult`. Use `.primary` for the common case; iterate
  `.variants` when handling Suno / Mureka or building provider-portable
  code.
- **Don't use music generation for spoken TTS.** Use
  `effect-uai-basic-speech-synthesis`.
- **Don't drop watermark metadata.** Surface or persist `watermark`
  ("synthid" / "c2pa") where downstream code needs provenance.

## See also

- Recipe source: `recipes/basic-music-generation/index.ts`
- Concept docs: `docs/music-generation/index.md`
- Migration guide: `docs/migrations/v0-7.md`
- For spoken audio: `effect-uai-basic-speech-synthesis`
