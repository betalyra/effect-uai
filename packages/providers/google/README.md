# @effect-uai/google

Google Gemini provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

Implements the `LanguageModel` contract against Google's Gemini API
with SSE streaming.

## Install

```sh
pnpm add @effect-uai/google @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers.

## Usage

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as googleLayer } from "@effect-uai/google"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return googleLayer({ apiKey })
  }),
)

const layer = Layer.provide(provider, FetchHttpClient.layer)
```

The layer registers both the provider-typed `Gemini` tag and the
generic `LanguageModel` tag.

## Docs

<https://effect-uai.betalyra.com/providers/gemini/>

## License

MIT
