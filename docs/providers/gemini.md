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
import { FetchHttpClient } from "effect/http"
import { Gemini, layer as geminiLayer } from "@effect-uai/google"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("GEMINI_API_KEY")
    return geminiLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`geminiLayer` registers two service tags from one underlying
implementation:

- **`Gemini`** - the typed tag. Yield this when you want
  Gemini-specific options (`thinkingLevel`, `thinkingBudget`).
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
Read it with `Config.Redacted("GEMINI_API_KEY")` or wrap manually with
`Redacted.make`.

`baseUrl` exists for proxies and self-hosted gateways that speak the
Gemini protocol. Most apps leave it unset.

## Request shape

```ts
interface GeminiRequest extends Omit<CommonRequest, "model"> {
  readonly model: GoogleModel // narrows CommonRequest.model: string
  readonly thinkingLevel?: "minimal" | "low" | "medium" | "high"
  readonly thinkingBudget?: number
}
```

On top of the core `CommonRequest` (`history`, `model`, `tools`,
`toolChoice`, `temperature`, `maxOutputTokens`):

- **`model`** - typed against `GoogleModel` for autocomplete at the
  call site.
- **`thinkingLevel`** - how long Gemini 3 and 4 think. Gemini 4 Argon
  and Carbon take `low`, `medium` (default) or `high`; `minimal` exists
  only on some Gemini 3 Flash models.
- **`thinkingBudget`** - Gemini 2.5 thinking budget in tokens. Set to
  `0` to disable thinking entirely (lowest latency, fastest
  first-token). Set either this or `thinkingLevel`, not both.

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

## Long answers (Gemini 4)

Gemini 4 can write far past what one response holds: it stops each
response at its per-response cap (64K tokens when streaming) and hands
back a token to continue. Such a turn stops with `"max_tokens"`, and
`continuationOf(turn)` returns the token. Whether to continue is your
call; nothing continues on its own.

To continue, send **the same request again** with the token. Don't append
the cut-off turn to the history: the token carries where the model was.
Keep `maxOutputTokens` the same; it counts across all the pieces.

```ts
import { Effect, Option, Stream } from "effect"
import * as Turn from "@effect-uai/core/Turn"
import { Gemini, type GeminiRequest, continuationOf } from "@effect-uai/google/Gemini"

/** Every piece's events in order, each piece ending in its own `TurnComplete`. */
const longAnswer = (request: GeminiRequest) =>
  Stream.unwrap(Effect.map(Gemini, (gemini) => gemini.streamTurn(request))).pipe(
    Stream.flatMap((event) =>
      Turn.isTurnComplete(event)
        ? Option.match(continuationOf(event.turn), {
            onNone: () => Stream.make(event),
            onSome: (continuationToken) =>
              Stream.concat(Stream.make(event), longAnswer({ ...request, continuationToken })),
          })
        : Stream.make(event),
    ),
  )
```

Text deltas stream straight through all pieces; join the pieces'
`Turn.assistantText` for the whole answer. Every piece is billed (earlier
output counts as input, mostly at the cached rate), so cap the pieces
you are willing to pay for, e.g. with a counter in the recursion.

A turn that stops with `"max_tokens"` and no token ran out of your own
`maxOutputTokens`, not Gemini's cap.

## Models

`GoogleModel` is a literal union with a `(string & {})` tail - you get
autocomplete on known IDs but can pass any string for models the SDK
hasn't been updated for yet.

Known IDs (as of November 2026): `gemini-4-carbon`, `gemini-4-argon`,
`gemini-3.8-flash`, `gemini-3.8-live`,
`gemini-3.8-live-extended-thinking`, `gemini-3.1-pro-preview`,
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
