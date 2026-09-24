---
title: Basic music generation
description: "A short prompt is enough. Two providers behind one `MusicGenerator` service tag: switch via `--provider=`."
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

const result =
  yield *
  generate({
    model: "music_v1", // or "lyria-3-clip-preview"
    prompt: "Lo-fi piano with brushed drums, 70 BPM, melancholic",
    duration: Duration.seconds(30),
    outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
  })

yield * writeFile("out.mp3", result.primary.audio.bytes)
```

The recipe yields the generic `MusicGenerator` service. The runner
([`run.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-music-generation/run.ts))
picks the Layer based on `--provider=`, so the same body works
against both providers without changes.

## Run it

```sh
# Default: ElevenLabs with the built-in prompt
ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run.ts

# Explicit provider
GOOGLE_API_KEY=...     pnpm tsx recipes/basic-music-generation/run.ts --provider google
ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run.ts --provider elevenlabs

# Custom prompt from a .txt file, 75-second clip
ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run.ts \
  --provider elevenlabs --duration 75 --prompt-file ./my-prompt.txt
```

Flags (`--name value` and `--name=value` both work):

| Flag            | Default      | Notes                                                                 |
| --------------- | ------------ | --------------------------------------------------------------------- |
| `--provider`    | `elevenlabs` | `elevenlabs` or `google`.                                             |
| `--prompt-file` | built-in     | Path to a `.txt` file. A bare positional path is **not** picked up.   |
| `--duration`    | `30`         | Clip length in seconds. ElevenLabs honors it; Lyria `clip` ignores it. |

Audio lands in `output/basic-music-generation/<timestamp>/track.mp3`.

## Writing a prompt that gets followed

In prompt mode ElevenLabs treats the text as a style brief. Things
that made a real difference while iterating on this recipe:

- **Spell the lyrics out.** Describing the lyrics ("a song that
  celebrates...") yields improvised, usually English, lyrics. Put the
  actual lines in the prompt under section tags (`[Verse 1]`,
  `[Chorus]`, `[Bridge]`) and say "with these exact lyrics".
- **Give it room.** 30 s is too short for a verse and a chorus with
  names in it. 60–120 s works for a short song.
- **Name the accent and pronunciation.** State the singer's origin
  and a couple of concrete phonetic cues (e.g. "castilian z, no
  seseo"). Spell out how unusual names should sound.
- **Never name real artists.** "In the style of <artist>" is
  rejected with a 4xx `InvalidRequest`. Describe the genre instead.

## Where the providers differ

The shared `MusicGenerator` surface intentionally hides most
differences. The ones worth knowing:

| Capability                                                 | Lyria 3 sync                                  | ElevenLabs Music                                                       |
| ---------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| Duration                                                   | Fixed 30 s for `clip`, controllable on `pro`. | Honored. `music_length_ms` 3 s – 10 min.                               |
| Streaming                                                  | Single chunk after sync (fake stream).        | Native chunked HTTP via `POST /v1/music/stream`.                       |
| Lyrics                                                     | No structured wire field; embed in prompt.    | Per-section `lines` in composition plan, or embed in prompt.           |
| Watermark                                                  | Always `"synthid"` (mandatory).               | Opt-in `"c2pa"` via `signWithC2pa: true` (MP3 only).                   |
| Vocals control                                             | Embed `"no vocals"` in your prompt.           | `forceInstrumental` on the typed request.                              |
| Composition plan (per-section lyrics + styles + durations) | .                                             | Yes (`compositionPlan`). Free plan-generator at `POST /v1/music/plan`. |

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
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-music-generation/recipe.ts).
