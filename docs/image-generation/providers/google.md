---
title: Google Images
description: Nano Banana 2 and Pro through the generic ImageGenerator. Text to image, edits conditioned on reference images, search-grounded generation.
---

Gemini's image models are exposed through `@effect-uai/google`. They are
the fast, cheap side of this capability: seconds rather than a minute,
and a fraction of the price per picture.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

## Layer

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as geminiImageLayer } from "@effect-uai/google/GeminiImageGenerator"

const images = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GEMINI_API_KEY")
    return geminiImageLayer({ apiKey })
  }),
)

const mainLayer = images.pipe(Layer.provide(FetchHttpClient.layer))
```

One implementation, two tags:

- **`GeminiImageGenerator`** — the typed tag. Yield this for
  `imageSize`, `thinkingLevel`, and search grounding.
- **`ImageGenerator`** — the generic tag. Yield this in
  provider-portable code.

**No `ImageStreaming`.** The image arrives whole, so `streamGeneration`
against this Layer is a compile error rather than a stream that never
previews.

## Models

| Model                         | Sizes           | Reference images                    | Search     |
| ----------------------------- | --------------- | ----------------------------------- | ---------- |
| `gemini-3.1-flash-image`      | 512, 1K, 2K, 4K | 10 objects + 4 characters           | web, image |
| `gemini-3.1-flash-lite-image` | 1K              | 14 objects                          | none       |
| `gemini-3-pro-image`          | 1K, 2K, 4K      | 6 objects + 5 characters + 3 styles | web        |

`GeminiImageModel` is a literal union with a `(string & {})` tail, so a
newly released id works without an SDK update.

## Generate

```ts
import { generate } from "@effect-uai/core/ImageGenerator"

const program = Effect.gen(function* () {
  const response = yield* generate({
    prompt: "A lighthouse in a storm, flat cel shading",
    model: "gemini-3.1-flash-image",
    aspectRatio: "3:2",
    resolution: "1K",
  })
  return response.images
})
```

Both the ratio and the tier are native fields here, so nothing is
derived. Whether a given model accepts the pair is the endpoint's call:
asking Lite for 4K is a 400, not a client-side error.

Every image comes back stamped: `watermark` is `"synthid"` on all three
models, and Lite additionally embeds a C2PA manifest.

## Edit

`edit` conditions generation on reference images, which is how you keep a
character or a product consistent across many images.

```ts
import { edit } from "@effect-uai/core/ImageGenerator"

const program = Effect.gen(function* () {
  const panel = yield* edit({
    prompt: "The same lighthouse at dawn, seen from the water",
    model: "gemini-3-pro-image",
    images: [reference],
    aspectRatio: "3:2",
  })
  return panel.images
})
```

References ride in the request body as base64, so a `url` image source
has no wire representation short of pre-uploading through the Files API.
On the typed request that is a **compile error**; on the generic one it
fails `InvalidRequest`. Fetch the URL yourself and pass the bytes.

The whole request, prompt and bytes together, has to fit in **20 MB**.

## One image per call

`n` above 1 fails `Unsupported`. `candidateCount` exists on the generic
request but its behaviour on image models is undocumented, and returning
one image where four were asked for is a different result rather than a
smaller one. Run the call as many times as you need, concurrently.

## Provider-typed extras

```ts
import { GeminiImageGenerator } from "@effect-uai/google/GeminiImageGenerator"

const program = GeminiImageGenerator.use((g) =>
  g.generate({
    prompt: "The Lisbon skyline as it looked this morning",
    model: "gemini-3.1-flash-image",
    imageSize: "512",
    thinkingLevel: "high",
    googleSearch: true,
  }),
)
```

- **`imageSize`** takes precedence over the portable `resolution`, which
  is then warn-dropped. It is also the only way to ask for `"512"`.
- **`thinkingLevel`** sets how long the model plans. Thinking is always
  on for image models and cannot be turned off.
- **`googleSearch`** grounds the image in live results. Flash and Pro
  only.

## Errors

| Situation                             | Error                                  |
| ------------------------------------- | -------------------------------------- |
| Prompt or image blocked               | `ContentFiltered`, carrying the reason |
| Model returned no image (`NO_IMAGE`)  | `GenerationFailed`                     |
| `n` above 1                           | `Unsupported`                          |
| URL reference on the generic tag      | `InvalidRequest`                       |
| Size or ratio the model does not take | `InvalidRequest`, from the endpoint    |

A refusal and an empty result are deliberately different: retrying a
`GenerationFailed` is reasonable, retrying a `ContentFiltered` is not.

## Cost

Per image at 1K: Lite **$0.034**, Flash **$0.067**, Pro **$0.134**. Flash
scales to $0.101 at 2K and $0.151 at 4K. Start on Lite and move up only
when the result is not good enough.

## See it working

The [storyboard recipe](/recipes/storyboard/) uses `generate` for a cast
of reference sheets and `edit` for every panel drawn from them.
