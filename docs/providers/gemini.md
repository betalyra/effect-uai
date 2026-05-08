---
title: Google Gemini
description: The Google Gemini provider - typed options, layer wiring, and supported models.
---

The Gemini provider wraps Google's `streamGenerateContent` SSE endpoint
and maps it onto the core `LanguageModelService` shape. Thinking budget
is a first-class option for the 2.5+ model line.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Gemini, layer as geminiLayer } from "@effect-uai/google"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GEMINI_API_KEY")
    return geminiLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`geminiLayer` registers two service tags from one underlying
implementation:

- **`Gemini`** - the typed tag. Yield this when you want
  Gemini-specific options (`thinkingBudget`).
- **`LanguageModel`** - the generic tag. Yield this in
  provider-portable code; only `CommonRequestOptions` is accepted at
  the call site.

## Config

```ts
interface Config {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string // defaults to https://generativelanguage.googleapis.com/v1beta
}
```

The layer carries connection details only. `model` is per call (see
below). `apiKey` is always `Redacted.Redacted` - never raw `string`.
Read it with `Config.redacted("GEMINI_API_KEY")` or wrap manually with
`Redacted.make`.

`baseUrl` exists for proxies and self-hosted gateways that speak the
Gemini protocol. Most apps leave it unset.

## Request shape

```ts
interface GeminiRequest extends Omit<CommonRequest, "model"> {
  readonly model: GoogleModel // narrows CommonRequest.model: string
  readonly thinkingBudget?: number
}
```

On top of the core `CommonRequest` (`history`, `model`, `tools`,
`toolChoice`, `temperature`, `maxOutputTokens`):

- **`model`** - typed against `GoogleModel` for autocomplete at the
  call site.
- **`thinkingBudget`** - Gemini 2.5+ thinking budget, forwarded as
  `generationConfig.thinkingConfig.thinkingBudget`. Set to `0` to
  disable thinking entirely (lowest latency, fastest first-token);
  higher values let the model think longer before emitting output.

## Calling it

```ts
import { Effect, Stream } from "effect"
import { Gemini } from "@effect-uai/google"

const turn = Effect.gen(function* () {
  const gemini = yield* Gemini
  return gemini.streamTurn({
    history,
    model: "gemini-2.5-flash",
    thinkingBudget: 0,
  })
})
```

`streamTurn` returns `Stream<TurnDelta, AiError>`. Pipe it through
`Loop.onTurnComplete` inside a `loop` body, or consume the deltas
directly for one-shot calls.

## Models

`GoogleModel` is a literal union with a `(string & {})` tail - you get
autocomplete on known IDs but can pass any string for models the SDK
hasn't been updated for yet.

Known IDs (as of April 2026): `gemini-3.1-pro-preview`,
`gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`,
`gemini-3.1-flash-live-preview`, `gemini-3.1-flash-tts-preview`,
`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`.
Reference: [Gemini models](https://ai.google.dev/gemini-api/docs/models).

## Errors

HTTP failures map to typed `AiError` variants:

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

Recover per-tag with `Stream.catchTag("RateLimited", handler)`. See
[multi-model fallback](/recipes/multi-model-fallback/) for cross-provider
recovery between Responses and Gemini.
