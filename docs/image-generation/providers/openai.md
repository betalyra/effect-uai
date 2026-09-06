---
title: OpenAI Images
description: gpt-image-2 through the generic ImageGenerator. Text to image, edits conditioned on reference images, and partial-image streaming.
---

OpenAI's Images API is exposed through `@effect-uai/openai`. Prompt in,
images out; `edit` conditions on reference images; partial frames stream in
while the final one renders.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/openai effect
```

## Layer

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as openaiImageLayer } from "@effect-uai/openai/OpenAIImageGenerator"

const images = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return openaiImageLayer({ apiKey })
  }),
)

const mainLayer = images.pipe(Layer.provide(FetchHttpClient.layer))
```

One implementation, three tags:

- **`OpenAIImageGenerator`** — the typed tag. Yield this for the full
  provider surface: exact `size`, `quality`, `background`, `outputFormat`,
  `outputCompression`, `moderation`, and a `mask` for inpainting.
- **`ImageGenerator`** — the generic tag. Yield this in provider-portable
  code.
- **`ImageStreaming`** — the capability marker gating `streamGeneration`.

`baseUrl` and `region` work as on the other OpenAI adapters, so the same
Layer reaches any OpenAI-compatible endpoint.

## Models

| Model                    | Notes                                             |
| ------------------------ | ------------------------------------------------- |
| `gpt-image-2`            | The alias, tracking whichever snapshot is current |
| `gpt-image-2-2026-04-21` | Pinned snapshot                                   |

`OpenAIImageModel` is a literal union with a `(string & {})` tail, so a
newly released id, or a gateway-prefixed one, works without an SDK update.

## Generate

```ts
import { generate } from "@effect-uai/core/ImageGenerator"

const program = Effect.gen(function* () {
  const response = yield* generate({
    prompt: "A lighthouse in a storm, flat cel shading",
    model: "gpt-image-2",
    aspectRatio: "3:2",
    resolution: "1K",
  })
  return response.images
})
```

Shape and size are a **ratio plus a tier**, not pixels, because pixel pairs
do not port between providers. The adapter turns them into the `"WxH"` the
wire wants. Pass an exact `size` on the typed request when you need one; it
takes precedence, and the ratio and tier are warn-dropped.

## Edit

`edit` conditions generation on reference images, which is how you keep a
character or a product consistent across many images.

```ts
import { edit } from "@effect-uai/core/ImageGenerator"

const program = Effect.gen(function* () {
  const panel = yield* edit({
    prompt: "The same lighthouse at dawn, seen from the water",
    model: "gpt-image-2",
    images: [reference],
    aspectRatio: "3:2",
  })
  return panel.images
})
```

The endpoint uploads bytes as multipart, so a `url` image source has no
wire representation. On the typed request that is a **compile error**; on
the generic one it fails `InvalidRequest`. Fetch the URL yourself and pass
the bytes.

The typed request also takes a `mask`: a PNG with an alpha channel, the
same dimensions as `images[0]`, where transparent pixels mark the region to
repaint.

## Streaming

`streamGeneration` and `streamEdit` emit `PartialImage` previews as the
image resolves, then one `Complete`. Both endpoints take `stream` and
`partial_images`, so an edit previews exactly like a generation:

```ts
import { isPartialImage, streamGeneration } from "@effect-uai/core/ImageGenerator"

streamGeneration({
  prompt: "A lighthouse in a storm",
  model: "gpt-image-2",
  partialImages: 2,
}).pipe(Stream.filter(isPartialImage))
```

Calling either against a Layer that does not register `ImageStreaming`
is a compile-time error, not a runtime failure.

## Errors

Range and per-model limits are not checked client-side: the request goes
out and the endpoint's answer is translated.

| Situation                        | Error                                  |
| -------------------------------- | -------------------------------------- |
| Moderation block                 | `ContentFiltered`, carrying the reason |
| Response with no image           | `GenerationFailed`                     |
| Ratio the arithmetic cannot use  | `InvalidRequest`                       |
| URL reference on the generic tag | `InvalidRequest`                       |

## Cost

`gpt-image-2` bills image output per token, so cost scales with pixels: a
2K image costs roughly four times a 1K one. Start at `1K`.

## See it working

The [storyboard recipe](/recipes/storyboard/) uses `generate` for a cast of
reference sheets and `edit` for every panel drawn from them.
