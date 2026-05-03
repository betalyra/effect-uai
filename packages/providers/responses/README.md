# @effect-uai/responses

OpenAI Responses API provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

Implements the `LanguageModel` contract against OpenAI's Responses API
(`POST /v1/responses` with SSE streaming). Provider-specific options
(`reasoning.effort`, `store`, `previousResponseId`) are reachable at
the call site without polluting the cross-provider surface.

## Install

```sh
pnpm add @effect-uai/responses @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers.

## Usage

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as responsesLayer } from "@effect-uai/responses"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const layer = Layer.provide(provider, FetchHttpClient.layer)
```

The layer registers both the provider-typed `Responses` tag (for
provider-specific calls) and the generic `LanguageModel` tag (for
provider-agnostic loop bodies).

## Docs

<https://effect-uai.betalyra.com/providers/responses/>

## License

MIT
