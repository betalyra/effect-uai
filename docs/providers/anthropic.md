---
title: Anthropic
description: The Anthropic Messages API provider - typed options, layer wiring, and supported models.
---

The Anthropic provider wraps `POST /v1/messages` with SSE streaming and
maps Claude's content-block model onto the core `LanguageModelService`
shape. Tool use, extended thinking, and prompt-caching token accounting
are all surfaced via the typed `AnthropicRequestOptions`.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/anthropic effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Anthropic, layer as anthropicLayer } from "@effect-uai/anthropic"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY")
    return anthropicLayer({ apiKey, defaultMaxTokens: 1024 })
  }),
)

const runtime = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`anthropicLayer` registers two service tags from one underlying
implementation:

- **`Anthropic`** - the typed tag. Yield this when you want
  Anthropic-specific options (`topK`, `stopSequences`, `thinking`, the
  `metadata.user_id`).
- **`LanguageModel`** - the generic tag. Yield this in
  provider-portable code; only `CommonRequestOptions` is accepted at
  the call site.

## Config

```ts
interface Config {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string // defaults to https://api.anthropic.com
  readonly defaultMaxTokens?: number // falls back to 4096
}
```

The layer carries connection details only. `model` is per call (see
below). `apiKey` is always `Redacted.Redacted` - never raw `string`.
Read it with `Config.redacted("ANTHROPIC_API_KEY")` or wrap manually
with `Redacted.make`.

`defaultMaxTokens` is needed because Anthropic requires `max_tokens` on
every request; we default to 4096 if neither the layer nor the per-call
`maxOutputTokens` overrides it. Bump it for long-form generations.

`baseUrl` exists for proxies, AWS Bedrock, and Vertex gateways that
speak the Messages protocol. Most apps leave it unset.

## Request shape

```ts
interface AnthropicRequest extends Omit<CommonRequest, "model"> {
  readonly model: AnthropicModel // narrows CommonRequest.model: string
  readonly topK?: number
  readonly stopSequences?: ReadonlyArray<string>
  readonly thinking?: { readonly type: "enabled"; readonly budget_tokens: number }
  readonly user?: string // becomes metadata.user_id on the wire
}
```

On top of the core `CommonRequest` (`history`, `model`, `tools`,
`toolChoice`, `temperature`, `topP`, `maxOutputTokens`):

- **`model`** - typed against `AnthropicModel` for autocomplete at the
  call site.
- **`topK`** - top-K sampling. Anthropic-specific; not on the common
  surface.
- **`stopSequences`** - early-termination strings. The model stops as
  soon as one matches.
- **`thinking`** - extended thinking configuration. Set
  `{ type: "enabled", budget_tokens: N }` to let the model reason for
  up to `N` tokens before answering. **Note:** Claude Opus 4.7 does
  _not_ support extended thinking (it uses adaptive thinking
  automatically); the option works on Sonnet 4.6 and Haiku 4.5.
- **`user`** - end-user identifier, sent as `metadata.user_id`. Useful
  for abuse routing and per-user telemetry.

## Calling it

```ts
import { Effect, Stream } from "effect"
import { Anthropic } from "@effect-uai/anthropic"

const turn = Effect.gen(function* () {
  const claude = yield* Anthropic
  return claude.streamTurn({
    history,
    model: "claude-sonnet-4-6",
    tools,
    thinking: { type: "enabled", budget_tokens: 4096 },
  })
})
```

`streamTurn` returns `Stream<TurnDelta, AiError>`. Pipe it through
`Loop.streamUntilComplete` inside a `loop` body, or consume the deltas
directly for one-shot calls.

## How history maps onto Anthropic's wire shape

Anthropic's Messages API expects strictly alternating `user` /
`assistant` turns, with content blocks (`text`, `tool_use`,
`tool_result`, `thinking`, `redacted_thinking`) inside each turn. The
codec handles the translation:

- `Items.userText(...)` and any `function_call_output` → user message
  with `text` and `tool_result` content blocks.
- Assistant `message`s, `function_call` items, and `reasoning` items
  → assistant message with `text`, `tool_use`, and `thinking` content
  blocks (in original order).
- `Items.systemText(...)` messages → request-level `system` field, not
  inserted into `messages`.
- Consecutive same-role items are folded into one message's content,
  matching Anthropic's alternation requirement.
- `function_call.arguments` is contractually a JSON string; the codec
  parses it into the `tool_use.input` object. Malformed JSON propagates
  as `AiError.InvalidRequest`.

## Models

`AnthropicModel` is a literal union with a `(string & {})` tail - you
get autocomplete on known IDs but can pass any string for models the
SDK hasn't been updated for yet.

**Latest tier (April 2026):**

- `claude-opus-4-7` - most capable; agentic-coding focus. Adaptive
  thinking only.
- `claude-sonnet-4-6` - speed + intelligence balance. Extended +
  adaptive thinking.
- `claude-haiku-4-5` (alias) / `claude-haiku-4-5-20251001` (snapshot)
  - fastest; extended thinking.

**Legacy tier (still available):** `claude-opus-4-6`,
`claude-sonnet-4-5`, `claude-opus-4-5`, `claude-opus-4-1`.

**Deprecated, retiring 2026-06-15:** `claude-sonnet-4-20250514`,
`claude-opus-4-20250514`. Migrate to `claude-sonnet-4-6` and
`claude-opus-4-7` respectively.

Reference: [Anthropic models](https://platform.claude.com/docs/en/docs/about-claude/models).

## Errors

HTTP failures map to typed `AiError` variants:

| Status      | Error                                      |
| ----------- | ------------------------------------------ |
| `429`       | `AiError.RateLimited`                      |
| `408`/`504` | `AiError.Timeout`                          |
| `401`       | `AiError.AuthFailed` (`auth`)              |
| `403`       | `AiError.AuthFailed` (`permission`)        |
| `402`       | `AiError.AuthFailed` (`billing`)           |
| `413`       | `AiError.ContextLengthExceeded`            |
| `529`       | `AiError.Unavailable` (`overloaded_error`) |
| `>= 500`    | `AiError.Unavailable`                      |
| other 4xx   | `AiError.InvalidRequest`                   |

Recover per-tag with `Stream.catchTag("RateLimited", handler)`. See
[multi-model fallback](/recipes/multi-model-fallback/) for cross-provider
recovery and [multi-model compare](/recipes/multi-model-compare/) for
fan-out across all three providers.

## Token accounting

Anthropic exposes prompt-cache reads via
`usage.cache_read_input_tokens`. The codec maps this onto the common
`Usage.input_tokens_details.cached_tokens`, so cached-token visibility
works the same way it does for OpenAI Responses and Gemini.
