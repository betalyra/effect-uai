---
title: Image generation
description: "Prompt to picture: text-to-image and image edit behind one service tag, portable across providers."
---

You need a picture: a product mock, a thumbnail variant, an
illustration draft, or an edit of an image your agent is already
holding. You want to write that once and not rewrite it when you
switch providers.

That is the `ImageGenerator` tag. A prompt goes in, images come out.

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

- **`generate`** — prompt in, images out.
- **`edit`** — prompt plus the images you want changed. Separate,
  because references are required here and meaningless there, and
  providers treat them as different endpoints.
- **`streamGeneration`** — preview frames while the image resolves,
  for when someone is watching a spinner. Gated by the
  `ImageStreaming` marker, so a provider that cannot preview is a
  compile error rather than a surprise at runtime.

## Ask for a shape, not pixels

```ts
readonly aspectRatio?: AspectRatio     // "1:1", "16:9", "21:9", …
readonly resolution?: ImageResolution  // "1K" | "2K" | "4K"
```

**Pixels don't port.** One provider takes `"1536x1024"`, the next takes
`16:9` plus `2K`, and a hardcoded pair silently becomes the wrong crop
when you switch. Ratio plus tier is what both understand, so adapters
derive the dimensions for you. Need exact pixels? Set them on that
provider's typed request and they win.

Not every model accepts every ratio, and the list changes with each
release, so rather than ship a table that goes stale the adapter sends
what you asked for and hands you the provider's answer.

## Feed the result into the next turn

```ts
const { images, usage } = yield* generate({ … })
const [{ image, watermark }] = images
```

`image` is an `ImageSource`, **the same type you pass into a
multimodal language model**, so a picture you just generated goes
straight into the next turn with no conversion. Adapters hand back the
bytes the provider sent, with its MIME type, and never re-encode.
`watermark` is set only when the provider stamped one, and every
`usage` field is optional since not all providers report.

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

Conditioning on references is also how you keep a character or a
product consistent across many images: see the
[storyboard recipe](/recipes/storyboard/).

Masks stay off the portable request, since only inpainting endpoints
have one; same for quality tiers, output encodings and moderation
levels. They live on the typed request of providers that support them.

## Previews while it renders

`streamGeneration` emits zero or more `PartialImage` frames, then
exactly one `Complete`. `Complete` carries the response fields flat, so
it _is_ an `ImageResponse`: filter for it and pass it on.

```ts
streamGeneration({ prompt, model, partialImages: 2 }).pipe(Stream.filter(isPartialImage))
```

## When something goes wrong

| Situation                                     | Error                                      |
| --------------------------------------------- | ------------------------------------------ |
| Prompt or output blocked by moderation        | `ContentFiltered`                          |
| Provider returned no image                    | `GenerationFailed`                         |
| Something the provider structurally cannot do | `Unsupported`, before the request goes out |

Asking for more images than an endpoint returns fails rather than
degrades: fewer images is a different result, not a smaller one.

## Providers

- [OpenAI](/image-generation/providers/openai/) — `gpt-image-2`,
  including edits and partial-image streaming.
