---
title: Language model
description: One generic service tag, three providers, and the seam between portable and provider-specific code.
---

Provider choice should be wiring, not program structure.

`LanguageModel` is the generic provider tag. Every provider's `layer`
registers itself under both its own typed tag (`Responses`, `Anthropic`,
`Gemini`) _and_ `LanguageModel`. Code that yields `LanguageModel` is
portable across providers; code that yields the typed tag gets that
provider's extended options.

This is the seam: write the agent harness once, then decide at the layer
boundary whether it runs on OpenAI, Anthropic, Gemini, or a test provider.

## The shape

```ts
interface LanguageModelService {
  readonly streamTurn: (request: CommonRequest) => Stream.Stream<TurnEvent, AiError>
}

class LanguageModel extends Context.Service<LanguageModel, LanguageModelService>()(...)
```

One method, one request bag. `history` and `model` are required; the
rest is the lowest common denominator across providers:

```ts
interface CommonRequest {
  readonly history: ReadonlyArray<Item>
  readonly model: string
  readonly tools?: ReadonlyArray<ToolDescriptor>
  readonly toolChoice?: "auto" | "required" | "none" | { type: "function"; name: string }
  readonly temperature?: number
  readonly topP?: number
  readonly maxOutputTokens?: number
  readonly structured?: StructuredFormat<unknown>
}
```

Anything outside this set (reasoning effort, prompt caching, store
flags, safety settings) lives on the provider-specific request shape,
not here.

## Two top-level helpers

```ts
import { streamTurn, turn } from "@effect-uai/core/LanguageModel"

streamTurn(request) // Stream<TurnEvent, AiError, LanguageModel>
turn(request) // Effect<Turn, AiError, LanguageModel>
```

`streamTurn` is the streaming primitive; `turn` runs the stream to
completion and pulls the assembled `Turn` from the terminal
`turn_complete` event. Both yield `LanguageModel`, so they work under
any provider's layer.

## Portable vs. provider-specific

Yield `LanguageModel` when your code should work under any provider:

```ts
import { streamTurn } from "@effect-uai/core/LanguageModel"

const program = streamTurn({ history, model: "gpt-5.4-mini", tools }).pipe(/* ... */)
```

Yield the typed tag when you need provider-specific options at the
call site (and to get autocomplete on `model`):

```ts
import { Responses } from "@effect-uai/responses"

const program = Effect.gen(function* () {
  const oai = yield* Responses
  return oai.streamTurn({
    history,
    model: "gpt-5.4-mini", // OpenAIModel literal completion
    tools,
    reasoning: { effort: "low" }, // Responses-only
    store: true, // Responses-only
  })
})
```

The same underlying implementation serves both tags - no double layer
construction, no fork. Mix them in the same program: yield `Responses`
for the one call that needs `reasoning.effort`, yield `LanguageModel`
everywhere else.

## Per-call model selection

Because `model` is per call rather than per layer, switching models
mid-program is just a different field. This is the seam recipes like
[auto-compaction](/recipes/auto-compaction/) and
[multi-model-fallback](/recipes/multi-model-fallback/) ride on:

```ts
const oai = yield* Responses
const draft = yield* runTurn({ history, model: "gpt-5.4-mini" }) // cheap
const final = yield* runTurn({ history, model: "gpt-5.4" }) // big
```

One layer, two models. The provider's HTTP API takes `model` in the
request body anyway, so this matches the wire shape - no abstraction
penalty.

## Layer registration

Each provider exports a `layer` that registers both tags:

```ts
import { layer as responsesLayer } from "@effect-uai/responses"
// Layer<Responses | LanguageModel, never, HttpClient>

import { layer as anthropicLayer } from "@effect-uai/anthropic"
// Layer<Anthropic | LanguageModel, never, HttpClient>

import { layer as geminiLayer } from "@effect-uai/google"
// Layer<Gemini | LanguageModel, never, HttpClient>
```

Provide one and `LanguageModel`-yielding code resolves; the typed tag
also resolves for code that wants the extended options. To swap
providers, swap the layer - the rest of the program is unchanged.

## When to compose providers

The [multi-model fallback](/recipes/multi-model-fallback/) and
[multi-model compare](/recipes/multi-model-compare/) recipes show
patterns that _do_ mix providers within one program. They yield each
provider's typed tag explicitly, because the point is to talk to two
distinct backends - not to abstract over them. Use `LanguageModel` for
"any provider"; use the typed tags when "which provider" is the
decision.

## What `LanguageModel` is not

- **Not an abstraction over response shape.** Every provider already
  emits the same `TurnEvent` union. `LanguageModel` adds nothing on
  top of that normalization.
- **Not a router.** It binds to whichever provider's layer you
  provided. To pick at runtime, build a `Layer` that selects.
- **Not extensible from outside.** New providers add cases by
  implementing `LanguageModelService`; user code doesn't subclass.

The tag is intentionally narrow. If you need the wider surface area,
yield the provider's typed tag.
