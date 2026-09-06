---
"@effect-uai/core": minor
"@effect-uai/openai": minor
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

- **`@effect-uai/openai/OpenAIImageGenerator`**: the first provider, on the
  Images API with `gpt-image-2`. Registers the typed tag, the generic one, and
  `ImageStreaming`. The typed request adds exact `size`, `quality`,
  `background`, `outputFormat`, `outputCompression`, `moderation`, and a `mask`
  for inpainting. `baseUrl` and `region` work as on the other OpenAI adapters,
  so the same Layer reaches an OpenAI-compatible gateway.
- Ratio and tier become `"WxH"` in the adapter. A ratio the arithmetic cannot
  consume fails `InvalidRequest`; setting `size` alongside `aspectRatio` or
  `resolution` warns rather than dropping the shape silently. Range and
  per-model limits are not checked client-side: the request goes out and the
  endpoint's error is translated. Moderation blocks become `ContentFiltered`,
  an empty response `GenerationFailed`.

See [image generation](https://effect-uai.betalyra.com/image-generation/).
