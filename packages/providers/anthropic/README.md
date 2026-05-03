# @effect-uai/anthropic

Anthropic Messages API provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

Implements the `LanguageModel` contract against Anthropic's Messages
API with SSE streaming, including extended thinking surfaced as
`reasoning_delta` events.

## Install

```sh
pnpm add @effect-uai/anthropic @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers.

## Usage

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as anthropicLayer } from "@effect-uai/anthropic"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY")
    return anthropicLayer({ apiKey })
  }),
)

const layer = Layer.provide(provider, FetchHttpClient.layer)
```

The layer registers both the provider-typed `Anthropic` tag and the
generic `LanguageModel` tag.

## Docs

<https://effect-uai.betalyra.com/providers/anthropic/>

## License

MIT
