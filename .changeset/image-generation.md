---
"@effect-uai/core": minor
---

New `ImageGenerator` capability (additive). A prompt goes in, images come out,
and the same call runs on any provider whose Layer you swap in.

- **`@effect-uai/core/ImageGenerator`**: the generic `ImageGenerator` tag plus
  `generate`, `edit`, and `streamGeneration` helpers. A request is
  `{ prompt, model, aspectRatio?, resolution?, n? }`; `edit` adds the reference
  `images` it conditions on. A response is
  `{ images: [{ image, watermark? }], usage }`, where `image` is the same
  `ImageSource` you pass into a multimodal language model, so a generated image
  feeds the next turn with no conversion.
- Size is a shape plus a tier (`aspectRatio` + `resolution`), not pixels:
  pixel pairs do not port between providers. Adapters whose wire wants exact
  dimensions derive them; exact pixels stay available on the provider-typed
  request.
- **`ImageStreaming`**: capability marker gating `streamGeneration`. A provider
  without a partial-image wire does not register it, so previewing against that
  Layer is a compile-time error.
- **`AspectRatio`** joins `@effect-uai/core/Media` alongside `Watermark`, which
  moved there from `Music` (re-exported unchanged) now that image results carry
  one too. `ImageResolution` and `GeneratedImage` are in
  `@effect-uai/core/Image`.

See [image generation](https://effect-uai.betalyra.com/image-generation/).
