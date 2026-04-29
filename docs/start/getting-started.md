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
pnpm add @betalyra/effect-uai-core @betalyra/effect-uai-responses effect
```

Each provider is its own package. The core package has no provider deps,
so edge / browser builds only pull in what you actually use.

## A first conversation

```ts
import { Config, Effect, Layer, Match, Stream, pipe } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@betalyra/effect-uai-core/Items"
import { loop, stop, streamUntilComplete } from "@betalyra/effect-uai-core/Loop"
import { matchType } from "@betalyra/effect-uai-core/Match"
import { Responses, layer as responsesLayer } from "@betalyra/effect-uai-responses"

const conversation = pipe(
  { history: [Items.userText("Write a haiku about the sea.")] },
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses
      return oai
        .streamTurn(state.history, {})
        .pipe(streamUntilComplete(() => Effect.sync(() => stop)))
    }),
  ),
)

const program = Stream.runForEach(conversation, (event) =>
  Match.value(event).pipe(
    matchType("text_delta", ({ text }) => Effect.sync(() => process.stdout.write(text))),
    Match.orElse(() => Effect.void),
  ),
)

const apiKey = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey, model: "gpt-5.4-mini" })
  }),
)

Effect.runPromise(
  program.pipe(Effect.provide(Layer.provide(apiKey, FetchHttpClient.layer))),
)
```

Run it:

```sh
OPENAI_API_KEY=sk-... pnpm tsx your-file.ts
```

You'll see the haiku stream into the terminal token-by-token, then the
process exits.

## What just happened

- **State** is a plain record. Here it's just `{ history }`, but it can
  carry whatever your loop needs (turn counters, pending prompts, a
  cursor into a queue).
- **`loop`** runs the body once per iteration. The body returns a
  `Stream` of events; values flow downstream to your consumer, and a
  terminal `stop` (or `nextAfter(s, state)`) decides what happens next.
- **`streamUntilComplete`** lifts the provider's raw `Stream<TurnDelta>`
  into the loop's event shape. Deltas pass through unchanged; once
  `turn_complete` arrives, the callback decides whether to continue or
  stop. Here we always `stop` after the first turn.
- **`Responses`** is the OpenAI provider tag. `responsesLayer({ apiKey,
  model })` registers it together with the generic `LanguageModel` tag
  so portable code can yield either.

## Next steps

- [The loop primitive](/concepts/loop/) - the full shape of `loop`,
  `Decision`, and `streamUntilComplete`.
- [Basic usage](/recipes/basic-usage/) - same skeleton plus a tool call
  and a continuation turn.
- [Providers](/providers/responses/) - OpenAI Responses and Google
  Gemini, their typed options, and how to swap between them.
