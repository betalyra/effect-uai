---
title: Google Video
description: Gemini Omni through the generic VideoGenerator. Text to video, first and last frames, image and video references, clips up to 15 seconds.
---

Gemini Omni is Google's video model, exposed through
`@effect-uai/google`. Every generation runs as a background job on
Google's side, so a long render never holds a connection open.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

## Layer

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { layer as omniLayer } from "@effect-uai/google/GeminiOmniVideoGenerator"

const video = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("GOOGLE_API_KEY")
    return omniLayer({ apiKey })
  }),
)

const mainLayer = video.pipe(Layer.provide(FetchHttpClient.layer))
```

One implementation, two tags:

- **`GeminiOmniVideoGenerator`**: the typed tag. Yield this for
  `delivery` and `task`.
- **`VideoGenerator`**: the generic tag. Yield this in provider-portable
  code.

## Models

`gemini-omni-1.2-flash`. Clips of 3 to 15 seconds (10 by default), at
`360p`, `720p` (default), `1080p` or `4k`; the two highest tiers are
upscaled. Aspect ratio `16:9` (default) or `9:16`. Every clip is 24 fps
MP4 with sound, and carries a SynthID watermark.

## Generate

```ts
import { Duration, Effect, Stream } from "effect"
import * as VideoGenerator from "@effect-uai/core/VideoGenerator"

const program = Effect.gen(function* () {
  const { videos } = yield* VideoGenerator.generate({
    model: "gemini-omni-1.2-flash",
    prompt: "Rain running down a window at night, soft focus city lights behind",
    duration: Duration.seconds(8),
    resolution: "1080p",
  })
  yield* VideoGenerator.toStream(videos[0]!.video).pipe(Stream.run(fs.sink("rain.mp4")))
})
```

Duration, camera moves, sound design and negatives ("no dialogue") all
belong in the prompt; Omni has no separate fields for them, and no seed.
A `seed` on the request is dropped with a warning.

## Where the clip lives

By default the finished clip stays in Google's Files API and comes back
as a **`ref`**: `{ provider: "gemini", id: "files/…" }`. Reading it
needs your API key, which is why you read it through the service:
`VideoGenerator.toStream(video)` sends the key for its own refs and for
nothing else. A ref is safe to store and log; it is useless without the
key.

Set `delivery: "inline"` on the typed request to get the clip back as
base64 in the poll response instead, which saves the download call.
Inline is capped at about 4 MB, roughly a 10-second 720p clip, so longer
or higher-resolution clips need the default.

## Frames and references

Omni reads images in order, and the roles you name become its task:

| `inputs`                                 | What Omni does                       |
| ---------------------------------------- | ------------------------------------ |
| `FirstFrame`                             | animates the image                   |
| `FirstFrame`, `LastFrame`                | interpolates from one to the other   |
| `ReferenceImage` and/or `ReferenceVideo` | keeps a character, product or motion |

```ts
VideoGenerator.submit({
  model: "gemini-omni-1.2-flash",
  prompt: "The two cats chase a ball of yarn across the kitchen",
  inputs: [
    VideoInput.ReferenceImage({ image: tabby }),
    VideoInput.ReferenceImage({ image: siamese }),
  ],
})
```

Up to 6 reference images. Reference videos are motion references of up
to 3 seconds: up to three for clips of 10 seconds or less, one for
longer ones. Frame and frame-to-frame clips run 3 to 10 seconds.

Mixing frames with references, or a last frame without a first, fails
`Unsupported`: Omni has no task for it. Images and videos go inline
(bytes or base64); a `url` source fails `Unsupported`, so fetch it first.
A clip Omni generated can go back in as a `ReferenceVideo` by its `ref`,
with no download or upload.

The prompt is where you say how each image is used. When it is not
enough, `task` on the typed request (`text_to_video`, `image_to_video`,
`reference_to_video`) overrides what the inputs imply; Google advises
prompting first, since a fixed task constrains the model.

## Errors

| Situation                              | Error                               |
| -------------------------------------- | ----------------------------------- |
| Omni failed or cancelled the job       | `GenerationFailed`, with its reason |
| A safety filter blocked prompt or clip | `ContentFiltered`, with its reason  |
| A ratio, tier or input mix Omni lacks  | `Unsupported`, before the request   |
| Rate limited                           | `RateLimited`                       |
| Bad key                                | `AuthFailed`                        |

## Cost

Billed per output token: a 10-second 720p clip is 57,920 video tokens,
about $0.70 at $12 per million. 360p uses about a third of that. Prices
move; check Google's pricing page.

## See it working

The [basic video generation recipe](/recipes/basic-video-generation/)
runs on Omni by default.
