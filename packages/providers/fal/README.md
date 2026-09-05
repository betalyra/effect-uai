# @effect-uai/fal

fal provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

Implements the `ImageGenerator` contract against fal's synchronous
endpoints, which is how you reach FLUX, Seedream, Qwen Image and the
rest of the open-weights field behind one key.

## Install

```sh
pnpm add @effect-uai/fal @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers.

## Usage

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as falLayer } from "@effect-uai/fal/FalImageGenerator"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("FAL_API_KEY")
    return falLayer({ apiKey })
  }),
)

const layer = Layer.provide(provider, FetchHttpClient.layer)
```

The layer registers both the provider-typed `FalImageGenerator` tag and
the generic `ImageGenerator` tag.

## The model id is an endpoint

On fal the model selects the URL, and generating and editing are
separate endpoints of the same family:

```ts
generate({ model: "bytedance/seedream/v5/pro/text-to-image", prompt })
edit({ model: "fal-ai/nano-banana-2/edit", prompt, images })
```

Copy the id off the model's page on fal.ai and pass it as `model`.

## Docs

<https://effect-uai.betalyra.com/image-generation/providers/fal/>

## License

MIT
