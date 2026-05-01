---
title: Getting started
description: Stream a one-shot reply from OpenAI in ~30 lines.
---

# Getting started

The smallest end-to-end shape: ask the model a question, stream its reply
to the console, and exit. No tools, no multi-turn loop, no provider
abstractions you don't need yet.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/responses effect
```

Each provider is its own package. The core package has no provider deps,
so edge / browser builds only pull in what you actually use.

## A first conversation

```ts
import { Config, Effect, Layer, Match, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import { matchType } from "@effect-uai/core/Match"
import { layer as responsesLayer } from "@effect-uai/responses"

const program = Stream.runForEach(
  streamTurn([Items.userText("Write a haiku about the sea.")]),
  (event) =>
    Match.value(event).pipe(
      matchType("text_delta", ({ text }) =>
        Effect.sync(() => process.stdout.write(text)),
      ),
      Match.orElse(() => Effect.void),
    ),
)

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey, model: "gpt-5.4-mini" })
  }),
)

Effect.runPromise(
  program.pipe(Effect.provide(Layer.provide(provider, FetchHttpClient.layer))),
)
```

Run it:

```sh
OPENAI_API_KEY=sk-... pnpm tsx your-file.ts
```

You'll see the haiku stream into the terminal token-by-token, then the
process exits.

## What just happened

- **`streamTurn`** runs one turn and yields a `Stream<TurnEvent>`:
  text deltas, reasoning, tool calls, and a terminal `turn_complete`.
  Here we only care about `text_delta`; everything else is ignored.
- **`matchType`** narrows the discriminated union of events. Add cases
  as you start caring about more of them.
- **`responsesLayer({ apiKey, model })`** registers the OpenAI provider
  under the generic `LanguageModel` tag, so `streamTurn` is
  provider-agnostic. Swap to `@effect-uai/anthropic` or
  `@effect-uai/google` and the `program` above is unchanged.

One turn, no tools, no continuation. To keep going after a tool call or
across multiple turns, you need `loop`, which is what the next page is
about.

## Next steps

- [The loop primitive](/concepts/loop/) - what `loop` is for, its shape,
  and how `streamUntilComplete` decides when to continue.
- [Basic usage](/recipes/basic-usage/) - the same skeleton plus a tool
  call and a continuation turn, with `loop` doing real work.
- [Providers](/providers/responses/) - OpenAI Responses, Anthropic, and
  Google Gemini, their typed options, and how to swap between them.
