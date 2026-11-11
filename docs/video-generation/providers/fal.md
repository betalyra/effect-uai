---
title: Fal Video
description: MiniMax H3, Seedance, Veo, Kling, LTX and the rest of Fal's video catalogue through the generic VideoGenerator, behind one key.
---

Fal hosts other people's video models. One key reaches MiniMax H3
(including the turbo tier that renders faster than it plays), Seedance,
Veo, Kling, LTX and more, through Fal's queue: every generation is a
job you submit and poll.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/fal effect
```

## Layer

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { layer as falVideoLayer } from "@effect-uai/fal/FalVideoGenerator"

const video = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("FAL_API_KEY")
    return falVideoLayer({ apiKey })
  }),
)

const mainLayer = video.pipe(Layer.provide(FetchHttpClient.layer))
```

One implementation, two tags:

- **`FalVideoGenerator`**: the typed tag. Yield this for the
  per-endpoint `wire` fields.
- **`VideoGenerator`**: the generic tag. Yield this in provider-portable
  code.

## The model id is an endpoint

On Fal, `model` names a **path**, and text-to-video and image-to-video
are separate endpoints of the same model:

```ts
VideoGenerator.submit({ model: "minimax/h3-max-turbo/text-to-video", prompt })
VideoGenerator.submit({ model: "minimax/h3-max/image-to-video", prompt, inputs: [first] })
```

The id is the model page's URL after `fal.ai/models/`. `FalVideoModel`
lists the current headliners for autocomplete and accepts any other id,
so new models work without an SDK update.

## Generate

```ts
import { Duration, Effect, Stream } from "effect"
import * as VideoGenerator from "@effect-uai/core/VideoGenerator"

const program = Effect.gen(function* () {
  const { videos } = yield* VideoGenerator.generate({
    model: "minimax/h3-max-turbo/text-to-video",
    prompt: "A paper boat drifting down a rain gutter, macro lens",
    duration: Duration.seconds(6),
  })
  yield* VideoGenerator.toStream(videos[0]!.video).pipe(Stream.run(fs.sink("boat.mp4")))
})
```

`duration` is sent in whole seconds, `FirstFrame` and `LastFrame` go to
the endpoint's frame fields, and `resolution` to its tier where the
model family has one. A tier the endpoint does not render fails
`Unsupported` rather than quietly rendering a different one; a field the
endpoint has no place for is dropped with a warning.

Results come back as a public link on Fal's CDN, a **`url`** that works
for anyone who holds it until it expires. Copy anything you want to keep
into your own storage.

## Per-endpoint fields

Fal's request bodies differ per model: one takes `negative_prompt`, the
next `generate_audio`, `camera_motion` or `num_frames`. Anything beyond
the portable fields goes in `wire`, merged into the body last:

```ts
import { FalVideoGenerator } from "@effect-uai/fal/FalVideoGenerator"

const program = FalVideoGenerator.use((g) =>
  g.submit({
    model: "minimax/h3-max/text-to-video",
    prompt,
    wire: { resolution: "768P", prompt_expansion_mode: "fast" },
  }),
)
```

Snake case, as Fal spells it. Reference images and videos have no field
shared across Fal's model families (`reference_image_urls` on one,
`image_urls` on the next), so they also go through `wire` under the name
the model page documents; a `ReferenceImage` or `ReferenceVideo` on the
portable request fails `Unsupported`.

## Errors

| Situation                              | Error                                 |
| -------------------------------------- | ------------------------------------- |
| The job failed or returned no video    | `GenerationFailed`, with Fal's reason |
| A field the endpoint does not take     | `InvalidRequest`                      |
| A tier or role the endpoint lacks      | `Unsupported`, before the request     |
| Cancelling a job that already finished | `InvalidRequest`                      |

## Cost

Per second of output, set per model: MiniMax H3 Max Turbo is about
$0.04 a second at 768p. Fal publishes the price on each model's page.

## See it working

```sh
FAL_API_KEY=... pnpm tsx recipes/basic-video-generation/run.ts \
  --model fal:minimax/h3-max-turbo/text-to-video
```

See the [basic video generation recipe](/recipes/basic-video-generation/).
