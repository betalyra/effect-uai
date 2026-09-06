---
"@effect-uai/fal": minor
---

New package: `@effect-uai/fal`, an `ImageGenerator` provider for fal.

One key reaches FLUX, Seedream, Qwen Image and the rest of the open-weights
field. `layer({ apiKey })` registers the provider-typed `FalImageGenerator` tag
and the generic `ImageGenerator` tag, so a recipe written against the generic
one runs here by swapping the Layer.

- On fal the model id **is** the endpoint, and generating and editing are
  separate endpoints of the same family. Copy the id off the model's page and
  pass it as `model`.
- `aspectRatio` and `resolution` become the endpoint's own size input, whether
  that is a named preset or exact pixels.
- Reference images for `edit` are attached under whichever field the chosen
  endpoint reads, so the same `edit` call works across endpoints that disagree
  on the spelling.
- Per-image and response-level extras (resolved seed, timings, dimensions) are
  on `providerData`; `imageDataOf` and `responseDataOf` decode them.

Partial-image streaming is not offered, so the package does not register
`ImageStreaming` and `streamGeneration` against this Layer is a compile-time
error.

See [fal](https://effect-uai.betalyra.com/image-generation/providers/fal/).
