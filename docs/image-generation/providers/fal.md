---
title: fal
description: FLUX, Seedream, Qwen Image and the open-weights field through the generic ImageGenerator, behind one key.
---

fal hosts other people's models. One key reaches FLUX.2, Seedream 5,
Qwen Image, Muse, and the sub-second open-weights tier, which is most of
the field you cannot get at directly.

That breadth is also the catch: fal is a catalogue behind one envelope,
not one API. Endpoints agree on auth, on `prompt`, and on the shape of
the result. They disagree on nearly everything else, and this adapter is
built around that fact rather than pretending otherwise.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/fal effect
```

## Layer

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as falImageLayer } from "@effect-uai/fal/FalImageGenerator"

const images = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("FAL_API_KEY")
    return falImageLayer({ apiKey })
  }),
)

const mainLayer = images.pipe(Layer.provide(FetchHttpClient.layer))
```

One implementation, two tags:

- **`FalImageGenerator`** — the typed tag. Yield this for exact pixel
  sizes, seeds, diffusion knobs, and the per-endpoint passthrough.
- **`ImageGenerator`** — the generic tag. Yield this in
  provider-portable code.

**No `ImageStreaming`.** fal has a `/stream` mechanism, but what it
carries is defined by each model rather than by fal, and no image
endpoint documents partial images. `streamGeneration` against this Layer
is a compile error rather than a stream that never previews.

## The model id is an endpoint

Everywhere else here, `model` names a model. On fal it names a **path**,
and generating and editing are separate endpoints of the same family:

```ts
generate({ model: "bytedance/seedream/v5/pro/text-to-image", prompt })
edit({ model: "fal-ai/bytedance/seedream/v4.5/edit", prompt, images })
```

The id is the model page's URL after `fal.ai/models/`. Copy it exactly:
whether an id carries the `fal-ai/` prefix varies even between
generations of one model, as those two lines show, and a wrong guess
comes back as `Application "seedream" not found` rather than something
that names the real problem.

`FalImageModel` lists the current headliners for autocomplete and its
`(string & {})` tail accepts the rest of the catalogue, so nothing waits
on an SDK update. Sending a generate id to `edit` gets fal's 422 for an
unknown field.

## Generate

```ts
import { generate } from "@effect-uai/core/ImageGenerator"

const program = Effect.gen(function* () {
  const response = yield* generate({
    prompt: "A lighthouse in a storm, flat cel shading",
    model: "fal-ai/flux-2-pro",
    aspectRatio: "3:2",
    resolution: "1K",
  })
  return response.images
})
```

The portable ratio and tier become `image_size: { width, height }`: the
tier is the short edge, the long edge follows the ratio. Presets like
`"landscape_4_3"` are named differently per model family, but the object
form is the shape they share, so pixels are what get sent.

The exception is the Google-lineage endpoints on fal (`fal-ai/nano-banana-2`),
which take `aspect_ratio` and `resolution` instead. Reach those through
[`input`](#per-endpoint-fields), or use
[`@effect-uai/google`](/image-generation/providers/google/) directly.

Images come back as inline bytes rather than a link, because this
adapter sends `sync_mode: true` by default. fal's CDN links expire, and
every other adapter here hands you bytes. Set `syncMode: false` if you
would rather have the link.

fal bills per image and per megapixel, so `usage` comes back empty.

## Edit

```ts
import { edit } from "@effect-uai/core/ImageGenerator"

const program = Effect.gen(function* () {
  const dawn = yield* edit({
    prompt: "The same lighthouse at dawn, seen from the water",
    model: "fal-ai/bytedance/seedream/v4.5/edit",
    images: [reference],
  })
  return dawn.images
})
```

fal reads references from URLs, and a data URI is a URL, so **every
image source works here**: a `url` reference goes through untouched and
bytes are inlined. This is the one adapter where holding a remote image
costs nothing.

## Provider-typed extras

```ts
import { FalImageGenerator } from "@effect-uai/fal/FalImageGenerator"

const program = FalImageGenerator.use((g) =>
  g.generate({
    prompt: "A lighthouse in a storm",
    model: "fal-ai/flux/schnell",
    imageSize: { width: 1280, height: 720 },
    seed: 42,
    numInferenceSteps: 4,
    guidanceScale: 3.5,
    outputFormat: "png",
  }),
)
```

`imageSize` takes precedence over the portable `aspectRatio` and
`resolution`, which are then warn-dropped. `seed` is what makes a
generation repeatable, which neither frontier provider offers.

### Per-endpoint fields

The knobs above are the ones image endpoints broadly agree on. For the
ones only a single endpoint takes, `input` is merged into the body last
and wins over everything derived:

```ts
g.generate({
  prompt,
  model: "fal-ai/flux/schnell",
  input: { acceleration: "high", loras: [{ path: url, scale: 0.8 }] },
})
```

Snake case, as the wire spells it. The escape hatch exists because fal's
schemas are per-model: a table of them here would be stale in a week,
and a field this adapter does not know about should not be a field you
cannot send.

## Errors

| Situation                          | Error                                    |
| ---------------------------------- | ---------------------------------------- |
| Prompt refused by a content check  | `ContentFiltered`, carrying fal's reason |
| Safety checker flagged every image | `ContentFiltered`                        |
| Endpoint returned no image         | `GenerationFailed`                       |
| Field the endpoint does not take   | `InvalidRequest`                         |
| Ratio that is not `"W:H"`          | `InvalidRequest`, before the request     |

fal validates bodies with Pydantic, so a refused prompt and a rejected
field both arrive as a 422; the entry's `type` is what separates them.

## Cost

Per image, roughly: FLUX.2 pro **$0.03** for the first megapixel plus
$0.015 per extra, Seedream 5 Pro **$0.0675** up to 1536², FLUX.1 schnell
a fraction of a cent. fal publishes the number on each model's page and
they move; check there rather than here.
