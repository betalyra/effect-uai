# @effect-uai/chat-completions

Reusable OpenAI Chat Completions provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

Implements the `LanguageModel` contract against the `POST /chat/completions`
wire dialect (SSE streaming, `messages[]`, `tool_calls`, `response_format`).
Point it at any compatible endpoint by setting `baseUrl`: OpenRouter, Requesty,
Groq, Together, or a self-hosted gateway.

> Prefer [`@effect-uai/responses`](https://www.npmjs.com/package/@effect-uai/responses)
> when the endpoint speaks the Responses protocol. Reach for chat-completions
> only when it does not: this dialect has no typed reasoning items and no
> server-side state (`store` / `previousResponseId`).

## Install

```sh
pnpm add @effect-uai/chat-completions @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers.

## Usage

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as chatLayer } from "@effect-uai/chat-completions/ChatCompletions"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("LLM_API_KEY")
    return chatLayer({
      apiKey,
      baseUrl: "https://openrouter.ai/api/v1",
      provider: "openrouter",
    })
  }),
)

const layer = Layer.provide(provider, FetchHttpClient.layer)
```

The layer registers the generic `LanguageModel` tag, so provider-agnostic loop
bodies run against it unchanged. `model` is a plain string: these gateways ship
hundreds of models, so there is no typed union.

`ChatConfig` also accepts `path`, `authHeader`, `extraHeaders`, and `extraBody`
for endpoints that diverge from the OpenRouter defaults.

## Docs

<https://effect-uai.betalyra.com/providers/>

## License

MIT
