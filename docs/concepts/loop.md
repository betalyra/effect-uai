---
title: The loop primitive
description: State, body, and a stream of events - the three things an agent loop needs.
---

The core thesis of `effect-uai`: **the user owns the loop**. State is a
plain record, the body is a `Stream`, and a small tagged event type
(`Value` / `Next` / `Stop`) controls iteration. There's no producer
fiber, no queue buffering - the next iteration is only pulled when the
downstream consumer pulls the outer stream.

## The shape

```ts
loop<S, A, E, R>(
  initial: S,
  body: (state: S) => Stream<Event<A, S>, E, R>,
): Stream<A, E, R>
```

Both data-first (`loop(initial, body)`) and data-last
(`pipe(initial, loop(body))`) forms work. The body may also return an
`Effect<Stream<...>>` so it can yield services before producing the
stream.

## The event type

Each pull, the body emits a chunk of `Event<A, S>`:

```ts
type Event<A, S> =
  | { _tag: "Value"; value: A }   // flows downstream
  | { _tag: "Next"; state: S }    // end this iteration, continue with new state
  | { _tag: "Stop" }              // end the loop entirely
```

A `Next` or `Stop` is **terminal for the iteration**. Anything emitted
in the same chunk after one is discarded - prefer the helpers below
over building events by hand.

## Helpers

```ts
Loop.value(a)              // wrap a value
Loop.next(state)           // signal continuation
Loop.stop                  // a single-element stream that ends the loop
Loop.nextAfter(stream, s)  // emit values from `stream`, then continue with state `s`
Loop.stopAfter(stream)     // emit values from `stream`, then end the loop
```

The two `*After` helpers are the workhorses: a body almost always wants
to "stream this turn's deltas, then advance / stop."

## `streamUntilComplete`

Most loop bodies wrap a provider's `Stream<TurnDelta>`. The pattern is
always the same: forward deltas to the consumer, wait for the terminal
`turn_complete`, then decide what to do with the assembled `Turn`.
`Loop.streamUntilComplete` packages exactly that:

```ts
import { Effect, Stream } from "effect"
import { loop, nextAfter, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import { Responses } from "@effect-uai/responses"

pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses

      return oai.streamTurn(state.history, { tools }).pipe(
        streamUntilComplete((turn) =>
          Effect.gen(function* () {
            const next = Turn.cursor(state, turn)
            const calls = Turn.functionCalls(turn)

            if (calls.length === 0) return stop

            const outputs = yield* Toolkit.executeAllSafe(toolkit, calls)
            return nextAfter(Stream.fromIterable(outputs), {
              ...next,
              history: [...next.history, ...outputs],
            })
          }),
        ),
      )
    }),
  ),
)
```

What it does:

- Each `TurnDelta` passes through as `Loop.value(delta)` - including the
  terminal `turn_complete`, so the consumer sees turn boundaries.
- Once the terminal arrives, the callback runs with the assembled
  `Turn` and its returned event-stream is concatenated. Typically that's
  tool outputs followed by `nextAfter(...)` or just `stop`.
- Pre-pipe transforms work as you'd expect: `Stream.tap` for logging,
  `Stream.filter` to drop deltas you don't care about, `Stream.map` to
  reshape them.

If the upstream ends without a `turn_complete`, the resulting stream
fails with `AiError.IncompleteTurn`. Catch it with `Stream.catchTag` if
you want to recover.

## Cancellation and resources

Because the loop is pull-based, structured concurrency works without
extra wiring:

- Each iteration's body stream lives in its own forked scope. When the
  iteration ends (decision arrives, error, downstream interrupt), that
  scope closes - finalizers attached to the body run synchronously.
- The outer scope owns whichever body is currently active. Closing the
  outer scope (e.g. via `Stream.interruptWhen` from a consumer) closes
  the active body too.
- This is why [mid-stream abort](/recipes/mid-stream-abort/) is a
  one-liner: the HTTP `Stream.ensuring` finalizer in the provider rides
  the same chain straight down to `AbortController.abort()` on the
  underlying `fetch`.

## Picking a provider

The loop primitive is provider-agnostic. The body just yields a
service tag and calls `streamTurn`. See [Providers](/providers/responses/)
for the OpenAI Responses and Google Gemini integrations and how to
swap between them at the layer or per-iteration.
