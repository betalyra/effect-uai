---
title: Image generation
description: Prompt to picture — text-to-image, image edit, and inpainting.
---

Sometimes the answer is a picture, not a paragraph.

Product mocks, illustration drafts, thumbnail variants, image edits
inside an agent's tool loop — they all want the same shape: a prompt
(plus optionally a reference image and a mask) goes in, one or more
images come out. Synchronous-ish: a few seconds, occasionally tens.

The interaction archetype is one-shot, same as embeddings. Streaming
intermediate images exists on a few providers but isn't broadly
supported, so the core abstraction stays simple.

## Coming soon

`@effect-uai/core` will ship an `ImageGenerator` service tag covering
text-to-image, image edit, and inpainting. Provider candidates:

- **OpenAI** — `gpt-image-1`, `dall-e-3`.
- **Google** — Imagen 3 / 4 via the Gemini API and Vertex.
- **Black Forest Labs** — Flux family (`flux-pro`, `flux-dev`).
- **Stability AI** — Stable Diffusion family.

The output type reuses the existing `MediaSource` / `Image` domain —
URL, base64, or bytes — so generated images compose with multimodal
language models without extra glue.

## Show interest

Open or +1 the
[image generation tracking issue](https://github.com/betalyra/effect-uai/issues/new?title=Capability%3A+Image+generation&body=I%27m+interested+in+image+generation+support.+Provider%28s%29%3A+%0AText-to-image%2C+edit%2C+inpaint%3A+%0A%0AUse+case%3A+).
