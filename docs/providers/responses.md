---
title: Responses / OpenAI
description: The OpenAI Responses API provider - typed options, layer wiring, and supported models.
---

# Responses / OpenAI

The Responses provider wraps OpenAI's `/v1/responses` SSE endpoint and
maps it onto the core `LanguageModelService` shape. Reasoning models,
tool calls, and response storage are all first-class via the typed
`ResponsesRequestOptions`.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/responses effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Responses, layer as responsesLayer } from "@effect-uai/responses"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey, model: "gpt-5.4-mini" })
  }),
)

const runtime = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`responsesLayer` registers two service tags from one underlying
implementation:

- **`Responses`** - the typed tag. Yield this when you want
  Responses-specific options (`reasoning.effort`, `store`,
  `previousResponseId`).
- **`LanguageModel`** - the generic tag. Yield this in
  provider-portable code; only `CommonRequestOptions` is accepted at
  the call site.

## Config

```ts
interface Config {
  readonly apiKey: Redacted.Redacted
  readonly model: OpenAIModel
  readonly baseUrl?: string  // defaults to https://api.openai.com/v1
}
```

`apiKey` is always `Redacted.Redacted` - never raw `string`. Read it
with `Config.redacted("OPENAI_API_KEY")` or wrap manually with
`Redacted.make`.

`baseUrl` exists for proxies / Azure / local LLM gateways that speak
the Responses protocol. Most apps leave it unset.

## Request options

```ts
interface ResponsesRequestOptions extends CommonRequestOptions {
  readonly reasoning?: { readonly effort: "low" | "medium" | "high" }
  readonly store?: boolean
  readonly previousResponseId?: string
}
```

On top of the core `CommonRequestOptions` (`tools`, `toolChoice`,
`temperature`, `maxOutputTokens`):

- **`reasoning.effort`** - reasoning depth for `gpt-5.x` models. With
  `effort` set, the model produces reasoning tokens before any output
  tokens, so streaming text deltas don't start immediately. Drop it for
  latency-sensitive flows.
- **`store`** - persist the response on OpenAI's side so it can be
  referenced via `previousResponseId` on a later turn.
- **`previousResponseId`** - resume from a stored response without
  re-sending the full history. See the
  [pause and resume recipe](/recipes/pause-resume/).

## Calling it

```ts
import { Effect, Stream } from "effect"
import { Responses } from "@effect-uai/responses"

const turn = Effect.gen(function* () {
  const oai = yield* Responses
  return oai.streamTurn(history, {
    tools,
    reasoning: { effort: "low" },
  })
})
```

`streamTurn` returns `Stream<TurnDelta, AiError>`. Pipe it through
`Loop.streamUntilComplete` inside a `loop` body, or consume the deltas
directly for one-shot calls.

## Models

`OpenAIModel` is a literal union with a `(string & {})` tail - you get
autocomplete on known IDs but can pass any string for models the SDK
hasn't been updated for yet.

Known IDs (as of April 2026): `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`,
`gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5`, `gpt-5-mini`,
`gpt-5-nano`, `gpt-5.3-codex`, `gpt-4.1`, `gpt-4.1-mini`,
`gpt-4o-mini`. Reference: [OpenAI models](https://developers.openai.com/api/docs/models/all).

## Errors

HTTP failures map to typed `AiError` variants:

| Status      | Error                              |
| ----------- | ---------------------------------- |
| `429`       | `AiError.RateLimited`              |
| `408`/`504` | `AiError.Timeout`                  |
| `401`       | `AiError.AuthFailed` (`auth`)      |
| `403`       | `AiError.AuthFailed` (`permission`)|
| `402`       | `AiError.AuthFailed` (`billing`)   |
| `413`       | `AiError.ContextLengthExceeded`    |
| `>= 500`    | `AiError.Unavailable`              |
| other 4xx   | `AiError.InvalidRequest`           |

Recover per-tag with `Stream.catchTag("RateLimited", handler)`. See
[multi-model fallback](/recipes/multi-model-fallback/) for cross-provider
recovery.
