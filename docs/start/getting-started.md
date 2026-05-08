---
title: One Turn Is A Stream
description: Stream one provider-agnostic model turn and handle the events you care about.
---

Start with the smallest primitive: one model turn.

A turn is not hidden behind an agent object or callback lifecycle. It is a
`Stream<TurnEvent>`. Text deltas, reasoning, tool-call events, usage updates,
and the final assembled turn all flow through the same typed stream. You can
render what you care about and ignore the rest.

This first example asks one question, prints streamed text, and exits. The
shape is intentionally small because the same stream is what later becomes a
tool-using conversation, a fallback ladder, or a resumable agent harness.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/responses effect
```

Each provider is its own package. The core package has no provider deps,
so edge / browser builds only pull in what you actually use.

## Stream One Turn

```ts
import { Config, Effect, Layer, Match, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import { layer as responsesLayer } from "@effect-uai/responses"

const program = Stream.runForEach(
  streamTurn({
    history: [Items.userText("Write a haiku about the sea.")],
    model: "gpt-5.4-mini",
  }),
  (event) =>
    Match.value(event).pipe(
      Match.discriminators("type")({
        text_delta: ({ text }) => Effect.sync(() => process.stdout.write(text)),
      }),
      Match.orElse(() => Effect.void),
    ),
)

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

Effect.runPromise(program.pipe(Effect.provide(Layer.provide(provider, FetchHttpClient.layer))))
```

Run it:

```sh
OPENAI_API_KEY=sk-... pnpm tsx your-file.ts
```

You'll see the haiku stream into the terminal token-by-token, then the
process exits.

## What This Buys You

- **The provider does not own your control flow.** You receive a normal
  Effect stream and decide how to consume it.
- **Events are typed data.** `Match.discriminators("type")({ text_delta, ... })`
  narrows the union; add cases when you want reasoning, usage, or
  tool-call events.
- **Provider choice is runtime wiring.** `responsesLayer({ apiKey })`
  implements the generic `LanguageModel` service. The program shape stays
  the same when you provide Anthropic or Gemini instead.
- **The final turn is still available.** The terminal `turn_complete` event
  carries the assembled `Turn`, which is what loops and structured-output
  validation build on.

One turn is enough for rendering a simple answer. To build an agent or chat,
you keep this stream shape and add one more primitive: `loop`.

## Next step

Head to **[Basic usage](/recipes/basic-usage/)** to turn this into a
tool-using conversation: stream a turn, inspect the completed turn, run the
requested tools, append their outputs, and continue.

## See also

- [The loop primitive](/concepts/loop/) - what `loop` is for, its shape,
  and how `onTurnComplete` decides when to continue.
- [Providers](/providers/responses/) - OpenAI Responses, Anthropic, and
  Google Gemini, their typed options, and how to swap between them.
