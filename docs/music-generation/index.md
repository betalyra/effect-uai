---
title: Music generation
description: Prompt to song — genre, mood, lyrics, instrumentation.
---

Prompted music generation is the newest AI model class — and the one
most likely to surprise you with how short the prompt can be.

"Lo-fi piano with brushed drums, 70 bpm" is enough. So is a hummed
melody plus "make this a salsa track". Use cases range from background
audio for a video to song drafts for a writer to sound effects for a
game. The shape is similar to video: prompt in, asset out, often with
the model taking long enough that an async-job interface fits better
than a synchronous wait.

## Coming soon

`@effect-uai/core` will ship a `MusicGenerator` service tag, sharing
the async-job archetype with video generation. Provider candidates:

- **Suno** — full-song generation with vocals.
- **Udio** — full-song generation, longer outputs.
- **Google Lyria / MusicLM** — when the public API stabilises.
- **Stability AI** — Stable Audio family.

Output reuses the `MediaSource` domain — URL or bytes — so generated
audio drops into the same pipelines as TTS output.

## Show interest

Open or +1 the
[music generation tracking issue](https://github.com/betalyra/effect-uai/issues/new?title=Capability%3A+Music+generation&body=I%27m+interested+in+music+generation+support.+Provider%28s%29%3A+%0AVocals%2Finstrumental%2Fboth%3A+%0A%0AUse+case%3A+)
to tell us what you'd build.
