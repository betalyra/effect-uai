---
title: Image generation
description: "Prompt to picture: text-to-image and image edit behind one service tag, portable across providers."
---

You need a picture: a product mock, a thumbnail variant, an
illustration draft, or an edit of an image your agent is already
holding. You want to write that once and not rewrite it when you
switch providers.

That is the `ImageGenerator` tag. A prompt goes in, images come out,
in a few seconds.

```ts
import { Effect } from "effect"
import { generate } from "@effect-uai/core/ImageGenerator"

const program = Effect.gen(function* () {
  const { images } = yield* generate({
    prompt: "A lighthouse at dusk, long exposure",
    model: "gpt-image-2",
    aspectRatio: "16:9",
    resolution: "2K",
  })
  return images
})
```

Swap the Layer and the same call runs on a different provider.

## Three calls

- **`generate`**: prompt in, images out.
- **`edit`**: prompt plus the images you want changed. A separate
  call because the reference images are required here and meaningless
  there, and providers treat the two as different endpoints.
- **`streamGeneration`**: preview frames while the image resolves,
  then the finished one. Useful when a user is watching. Gated by the
  `ImageStreaming` marker, so a provider that can't preview is a
  compile-time error rather than a surprise at runtime.

## Asking for a size

You ask for a **shape and a tier**, not pixels:

```ts
readonly aspectRatio?: AspectRatio     // "1:1", "16:9", "21:9", …
readonly resolution?: ImageResolution  // "1K" | "2K" | "4K"
```

Pixels don't port. One provider takes `"1536x1024"`, the next takes
`16:9` plus `2K`, and a hardcoded pixel pair silently becomes the
wrong crop when you switch. Ratio plus tier is what both understand,
so adapters whose wire wants exact dimensions derive them for you.
When you do need exact pixels, set them on that provider's typed
request and they win.

Not every model accepts every ratio or tier, and the list changes
with each model release. Rather than shipping a table that goes stale,
the adapter sends what you asked for and hands you the provider's
rejection.

## What you get back

```ts
type ImageResponse = {
  readonly images: ReadonlyArray<GeneratedImage>
  readonly usage: ImageUsage // all fields optional
}

type GeneratedImage = {
  readonly image: ImageSource
  readonly watermark?: Watermark // "synthid" | "c2pa" | (string & {})
}
```

`image` is an `ImageSource`, the same type you pass _into_ a
multimodal language model. So the picture you just generated goes
straight into the next turn with no conversion step. Adapters hand
back the bytes the provider sent, with its MIME type, and never
re-encode.

`watermark` is set only when the provider stamped one.

## Editing

Pass the images you want changed alongside the prompt:

```ts
const dawn = Effect.gen(function* () {
  const dusk = yield* generate({ prompt: "A lighthouse at dusk", model: "gpt-image-2" })
  return yield* edit({
    prompt: "Make it dawn instead of dusk",
    model: "gpt-image-2",
    images: [dusk.images[0]!.image],
  })
})
```

Masks are not in the portable request: only inpainting endpoints have
one, so it lives on the typed request of providers that do. Same for
quality tiers, output encodings, and moderation levels. `seed` and
`negativePrompt` are absent because no in-tree provider has them.

## Streaming previews

```ts
type ImageStreamEvent = Data.TaggedEnum<{
  PartialImage: { image: ImageSource; index: number }
  Complete: { images: ReadonlyArray<GeneratedImage>; usage: ImageUsage }
}>
```

Zero or more `PartialImage` frames, then exactly one `Complete`.
`Complete` carries the response fields flat, so it _is_ an
`ImageResponse`: filter for it and pass it on.

## When something goes wrong

- Prompt or output blocked by moderation: `AiError.ContentFiltered`.
- The provider returned no image at all: `AiError.GenerationFailed`.
- You asked for something the provider structurally cannot do, like
  more images than its endpoint returns: `AiError.Unsupported`,
  before the request goes out. Fewer images than you asked for is a
  different result, not a smaller one, so it fails rather than
  degrades.

## Notes

`AspectRatio` lives in `@effect-uai/core/Media`: video generation
takes the same strings. `ImageResolution` stays image-specific, since
video models tier by scan height instead.

## Providers

Adapter pages land with their adapters.
