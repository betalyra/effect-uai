---
name: effect-uai-basic-music-generation
description: Use when the user wants to generate music with effect-uai — prompt to audio, background music, song drafts, Lyria 3 clips, weighted prompt blends, lyrics with verse/chorus tags, BPM/key hints, or SynthID watermark handling. Covers MusicGenerator.generate, MusicResult, Google Lyria layer wiring, and simple vs weighted music prompts.
license: MIT
---

# effect-uai basic-music-generation

Prompt in, music bytes out. Use `MusicGenerator.generate` for short
background clips, song sketches, or demos.

Reach for this when the user says any of:

- "Generate music / background audio from a prompt"
- "Use Lyria with effect-uai"
- "Blend music prompt influences with weights"
- "Add lyrics, BPM, or key hints"

## Simple prompt

```ts
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"

export const generateSimple = MusicGenerator.generate({
  model: "lyria-3-clip-preview",
  prompts: "Lo-fi piano with brushed drums, 70 bpm",
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
})
```

`lyria-3-clip-preview` returns a fixed 30-second MP3.

## Weighted prompt

```ts
export const generateWeighted = MusicGenerator.generate({
  model: "lyria-3-clip-preview",
  prompts: [
    { text: "1980s synthwave", weight: 1.0 },
    { text: "John Carpenter movie OST", weight: 0.4 },
  ],
  bpm: 100,
  scale: "A_MINOR",
  lyrics: "[Verse]\nNeon city, midnight drive\n[Chorus]\nKeep the dream alive",
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
})
```

Use weighted prompts when the user wants blended influences. `lyrics`
may include section tags like `[Verse]` and `[Chorus]`; `bpm`, `scale`,
and `instrumental` are musical hints.

## Result

```ts
type MusicResult = AudioBlob & {
  readonly songId?: string
  readonly lyrics?: string
  readonly sections?: ReadonlyArray<{ label: string; startSeconds: number; endSeconds: number }>
  readonly watermark?: { kind: string }
}
```

Lyria outputs carry SynthID; preserve `result.watermark` for
provenance. Use `lyria-3-pro-preview` when the user needs longer clips
or WAV output.

## Provider shape

Today the implementation is Google's Lyria layer, but recipe code
should yield the generic `MusicGenerator` tag. Future providers can
hide polling, streaming, or job IDs behind the same service boundary.

## Anti-patterns

- **Don't use music generation for spoken TTS.** Use
  `effect-uai-basic-speech-synthesis`.
- **Don't drop watermark metadata.** Surface or persist `watermark`
  where downstream code needs provenance.
- **Don't assume weighted prompts are native wire fields.** Some
  adapters flatten hints into prompt text.

## See also

- Recipe source: `recipes/basic-music-generation/index.ts`
- Concept docs: `docs/music-generation/index.md`
- For spoken audio: `effect-uai-basic-speech-synthesis`
