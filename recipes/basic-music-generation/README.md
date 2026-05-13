---
title: Basic music generation
description: "Generate a short music clip with Google Lyria 3: `generateSimple` for a single prompt, `generateWeighted` for blended influences with lyrics and structural hints. Accepts an optional `.txt` or `.json` file for a custom prompt."
---

Generate a short music clip with Google's Lyria 3 music-generation models via the Gemini REST API.

Two variants:

- `generateSimple` — `lyria-3-clip-preview`, single text prompt.
- `generateWeighted` — `lyria-3-clip-preview`, blended `WeightedPrompt[]` with optional `[Verse]` / `[Chorus]` lyrics and `bpm` / `scale` hints (flattened into the prompt text — Lyria 3 sync has no structured weighted-prompt field; that's Lyria RealTime).

`lyria-3-clip-preview` is fixed at 30 s of MP3 output. For longer clips or WAV, switch to `lyria-3-pro-preview` inside `index.ts`.

Lyria 3 RealTime (live bidirectional sessions with mid-stream prompt updates) is **not** demonstrated here — that ships in a follow-up phase over a `BidiGenerateMusic` WebSocket. The `@effect-uai/google` `LyriaGenerator` Layer therefore omits the `MusicInteractiveSession` capability marker, so calling `MusicGenerator.streamGenerationFrom` against it is a compile-time error.

Every output carries a SynthID watermark — surfaced as `result.watermark` on the returned `MusicResult`.

## Run

No arguments → runs both built-in variants:

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts
```

With a `.txt` file → runs only the simple variant, using the file contents as the prompt:

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts \
  recipes/basic-music-generation/prompts/birthday-danielo.txt
```

With a `.json` file → runs only the weighted variant, parsed as `WeightedConfig` (see `index.ts` for the shape):

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts ./my-track.json
```

Writes `out-simple.mp3` and/or `out-weighted.mp3` next to the recipe.

## Example prompts

- [`prompts/birthday-danielo.txt`](./prompts/birthday-danielo.txt) — a subtle, modern birthday song bridging pagode from Minas Gerais and Movida Madrileña.
