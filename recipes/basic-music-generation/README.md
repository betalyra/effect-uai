---
title: Basic music generation
description: A short prompt is enough. Lyria 3 turns it into a 30-second clip.
---

A short prompt is enough to get useful background music.

Give the model a vibe, a tempo hint, or a rough song structure and it
returns audio bytes you can write to disk. The recipe shows the small
path first, then a richer prompt with weighted influences and lyrics.

**Scenario.** You need background audio for a video, a song draft for
a demo, or a quick musical sketch. You want a 30-second clip from a
prompt, not a local model or a new provider SDK.

## Simple Or Directed

```ts
import { generate } from "@effect-uai/core/MusicGenerator"

// Simple
const simple = yield* generate({
  model: "lyria-3-clip-preview",
  prompts: "Lo-fi piano with brushed drums, 70 bpm",
})
yield* writeFile("out-simple.mp3", simple.bytes)

// Weighted
const weighted = yield* generate({
  model: "lyria-3-clip-preview",
  prompts: [
    { text: "minimal techno", weight: 0.7 },
    { text: "ambient pad",   weight: 0.3 },
  ],
  bpm: 124,
  scale: "A_MINOR",
  lyrics: "[Verse]\nA late train hums beneath the city\n",
})
yield* writeFile("out-weighted.mp3", weighted.bytes)
```

Both calls use the same `MusicGenerator.generate` boundary: prompt in,
`MusicResult` out. The simple prompt is enough for most demos. The
weighted prompt is useful when you want to blend influences, preserve a
song section shape, or carry musical hints like `bpm` and `scale`.

`lyria-3-clip-preview` returns a fixed 30-second MP3. Use
`lyria-3-pro-preview` in `index.ts` when you want longer clips or WAV
output.

Lyria adds a SynthID watermark. The adapter surfaces that as
`result.watermark`, so downstream code can preserve provenance.

## Run it

```sh
# Both built-in variants
GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts

# Custom simple prompt from a .txt file
GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts ./my-prompt.txt

# Custom weighted prompt from a .json file (see index.ts for the WeightedConfig shape)
GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts ./my-track.json
```

Writes `out-simple.mp3` and/or `out-weighted.mp3` next to the recipe.

## What This Generalizes To

Today this runs on Google's Lyria layer, but the recipe body yields the
generic `MusicGenerator` service. Future providers can hide job polling,
streaming, or session setup behind the same boundary.

For the broader model surface and planned interactive sessions, see
[Music generation](/music-generation/). For spoken audio instead of
music, see [Basic speech synthesis](/recipes/basic-speech-synthesis/).

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-music-generation/index.ts).
