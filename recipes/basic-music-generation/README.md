---
title: Basic music generation
description: A short prompt is enough. Two providers behind one `MusicGenerator` service tag — switch via `--provider=`.
---

A short prompt is enough to get useful music.

Give the model a vibe, a tempo hint, or a rough song structure and it
returns audio bytes you can write to disk. The recipe runs against
either **Google Lyria** (30 s MP3 clip; `lyria-3-clip-preview`) or
**ElevenLabs Music** (full song up to 5 min; `music_v1`), depending
on `--provider=`.

**Scenario.** You need background audio for a video, a song draft for
a demo, or a quick musical sketch. You want to compare what two
providers do with the same prompt.

## The recipe body is provider-agnostic

```ts
import { Duration } from "effect"
import { generate } from "@effect-uai/core/MusicGenerator"

const result = yield* generate({
  model: "music_v1",      // or "lyria-3-clip-preview"
  prompt: "Lo-fi piano with brushed drums, 70 BPM, melancholic",
  duration: Duration.seconds(30),
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
})

yield* writeFile("out.mp3", result.primary.audio.bytes)
```

The recipe yields the generic `MusicGenerator` service. The runner
([`run-node.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-music-generation/run-node.ts))
picks the Layer based on `--provider=`, so the same body works
against both providers without changes.

## Run it

```sh
# Default: Google Lyria with the built-in prompt
GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts

# Explicit provider
GOOGLE_API_KEY=...     pnpm tsx recipes/basic-music-generation/run-node.ts --provider=google
ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts --provider=elevenlabs

# Custom prompt from a .txt file
ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts --provider=elevenlabs ./my-prompt.txt
```

Writes `out-google.mp3` or `out-elevenlabs.mp3` next to the recipe.

## Where the providers differ

The shared `MusicGenerator` surface intentionally hides most
differences. The ones worth knowing:

| Capability                                                  | Lyria 3 sync                                  | ElevenLabs Music                                                                    |
| ----------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Duration                                                    | Fixed 30 s for `clip`, controllable on `pro`. | Honored. `music_length_ms` 3 s – 10 min.                                            |
| Streaming                                                   | Single chunk after sync (fake stream).        | Native chunked HTTP via `POST /v1/music/stream`.                                    |
| Lyrics                                                      | No structured wire field; embed in prompt.    | Per-section `lines` in composition plan, or embed in prompt.                        |
| Watermark                                                   | Always `"synthid"` (mandatory).               | Opt-in `"c2pa"` via `signWithC2pa: true` (MP3 only).                                |
| Vocals control                                              | Embed `"no vocals"` in your prompt.           | `forceInstrumental` on the typed request.                                           |
| Composition plan (per-section lyrics + styles + durations)  | —                                             | Yes (`compositionPlan`). Free plan-generator at `POST /v1/music/plan`.              |

These provider-specific knobs live on the **typed** services
(`LyriaGenerator`, `ElevenLabsMusicGenerator`), not on the
cross-provider `CommonGenerateMusicRequest`. Reach for them when the
shared surface isn't expressive enough.

## What this generalises to

The recipe body returns Effects that yield the generic
`MusicGenerator` service. Future providers (Suno, Mureka, MiniMax,
Stable Audio, Tencent SongGen) can hide their job polling, streaming,
or session setup behind the same calls. The
[music generation overview](/music-generation/) covers the cross-provider
shapes and the capability marker that gates bidirectional sessions.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-music-generation/index.ts).
