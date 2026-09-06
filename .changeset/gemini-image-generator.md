---
"@effect-uai/google": minor
---

New `GeminiImageGenerator`: the `ImageGenerator` contract on Gemini's image
models. `layer({ apiKey })` registers the provider-typed tag and the generic
one, and the typed request adds Gemini's own `imageConfig` knobs alongside the
shared `aspectRatio` and `resolution`.

Partial-image streaming is not offered, so `ImageStreaming` is not registered.
