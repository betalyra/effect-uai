---
title: Mistral
description: "Use Mistral's chat models with effect-uai: wiring, per-call options, structured output, and the model lineup."
---

Mistral's chat models (the fast, low-cost `mistral-small`, the
flagship `mistral-large`, and the `magistral` reasoning line) plug into
effect-uai through the generic `LanguageModel` tag. Write your agent
loop, tool calls, and structured-output flows once and run them on
Mistral by swapping in this layer. The same package also ships Mistral's
Voxtral [speech surface](/speech/providers/mistral/).

## Install

```sh
pnpm add @effect-uai/core @effect-uai/mistral effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Mistral, layer as mistralLayer } from "@effect-uai/mistral/Mistral"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("MISTRAL_API_KEY")
    return mistralLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

The layer gives you two ways to reach the model:

- yield **`LanguageModel`** for provider-portable code: switch
  providers later by swapping the layer, nothing else;
- yield **`Mistral`** when you want Mistral's extra request options.

## Config

```ts
interface Config {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string // defaults to https://api.mistral.ai
}
```

`apiKey` is always `Redacted.Redacted`. Read it with
`Config.redacted("MISTRAL_API_KEY")` or wrap a string with
`Redacted.make`. Set `baseUrl` only when you go through a proxy or
gateway; most apps leave it unset. The model is chosen per call, not on
the layer.

## Calling it

```ts
import { Effect } from "effect"
import { Mistral } from "@effect-uai/mistral/Mistral"

const turn = Effect.gen(function* () {
  const mistral = yield* Mistral
  return mistral.streamTurn({
    history,
    model: "mistral-small-latest",
    tools,
  })
})
```

`streamTurn` returns a `Stream` of turn deltas; drive it from a `loop`
body or consume the deltas directly for one-shot calls. `turn` gives you
the assembled result in one `Effect` when you don't need streaming.

## Per-call options

Each call takes a `model` plus the usual request fields (`history`,
`tools`, `toolChoice`, `temperature`, `topP`, `maxOutputTokens`,
`structured`) and two Mistral-specific extras you get when you yield the
typed `Mistral` tag:

- **`safePrompt`**: prepend Mistral's safety guardrail system prompt.
- **`randomSeed`**: fix the sampling seed for reproducible output.

### Tools

Pass a `Toolkit` as `tools` and use `toolChoice` to steer it: let the
model decide (`"auto"`), force it to call a tool (`"required"`), forbid
tools (`"none"`), or pin a specific function
(`{ type: "function", name }`). Mistral supports parallel tool calls. See
[tools and toolkits](/language-models/tools/).

### Structured output

Set `structured` to a `StructuredFormat` and the model returns JSON that
matches your schema. Validate it with `Turn.decodeStructured`. See
[structured output](/recipes/structured-output/).

## Models

`MistralModel` gives you autocomplete on known IDs while still accepting
any string, so a freshly released model works without an SDK bump. Prefer
the `-latest` aliases for evergreen pins.

- **`mistral-large-latest`**: most capable; complex reasoning and
  agentic work.
- **`mistral-medium-latest`**: balanced quality and cost.
- **`mistral-small-latest`**: fast and cheap; a good default for tool
  loops and voice.
- **`magistral-medium-latest`** / **`magistral-small-latest`**:
  reasoning models.
- **`ministral-8b-latest`** / **`ministral-3b-latest`**: lightweight,
  edge-friendly.
- **`codestral-latest`**: code-specialized.

Reference: [Mistral models](https://docs.mistral.ai/getting-started/models/models_overview).

## Errors

Failures surface as typed `AiError` variants you can recover per-tag with
`Stream.catchTag(...)`:

| Status      | Error                               |
| ----------- | ----------------------------------- |
| `429`       | `AiError.RateLimited`               |
| `408`/`504` | `AiError.Timeout`                   |
| `401`       | `AiError.AuthFailed` (`auth`)       |
| `403`       | `AiError.AuthFailed` (`permission`) |
| `402`       | `AiError.AuthFailed` (`billing`)    |
| `413`       | `AiError.ContextLengthExceeded`     |
| `>= 500`    | `AiError.Unavailable`               |
| other 4xx   | `AiError.InvalidRequest`            |

See [multi-model fallback](/recipes/multi-model-fallback/) for
cross-provider recovery.
