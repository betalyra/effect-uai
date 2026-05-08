---
name: effect-uai-mid-stream-abort
description: Use when the user wants to cancel an in-flight model turn cleanly — e.g. user clicks "stop", a new prompt arrives mid-generation, a deadline elapses. The upstream HTTP connection drops via Effect's structured concurrency; partial deltas already emitted stay with the consumer.
license: MIT
---

# effect-uai mid-stream-abort

Cancel an in-flight `streamTurn` cleanly via
`Stream.interruptWhen(Deferred.await(abort))`. When the deferred
completes, the stream interrupts, its scope closes, Effect's
structured concurrency tears down the HTTP response, and the underlying
`fetch` is aborted — the TCP connection drops.

Reach for this when the user says any of:

- "Stop button for the model"
- "Abort the current turn when a new prompt arrives"
- "Hard deadline on a single response"

## The pattern

```ts
import { Deferred, Effect, Stream, pipe } from "effect"
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"

const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses
      return oai
        .streamTurn({ history: state.history, model: "gpt-5.4-mini" })
        .pipe(onTurnComplete(() => Effect.sync(() => stop)))
    }),
  ),
)

const program = Effect.gen(function* () {
  const abort = yield* Deferred.make<void>()

  // Trigger lives outside the loop. Replace the timer with whatever
  // fits your app: UI signal, Queue.take, Effect.async wrapping
  // AbortSignal, etc.
  yield* Effect.forkChild(
    Effect.sleep("1 second").pipe(Effect.zipRight(Deferred.succeed(abort, undefined))),
  )

  yield* Stream.runForEach(
    conversation.pipe(Stream.interruptWhen(Deferred.await(abort))),
    (event) => /* ... */,
  )
})
```

## What happens on abort

1. `Deferred.await(abort)` resolves.
2. `Stream.interruptWhen` interrupts the conversation stream.
3. The stream's scope closes; finalizers run end-to-end.
4. The provider's `streamTurn` had registered a finalizer (via
   `Stream.ensuring`) that calls `AbortController.abort()` on the
   underlying `fetch`. The TCP connection drops.
5. The `runForEach` returns; the program continues.

## State and partial completions

The body's `onTurnComplete` callback never sees `turn_complete`
when abort fires — `state` stays at its pre-turn value. If you need
the partial assistant text to survive abort:

- **Capture deltas as they stream** — keep a running buffer in a
  `Ref` outside the loop. The interrupted stream still emitted them,
  so they land in the buffer before the abort.
- **Synthesize a partial `Turn`** in the consumer when the stream
  ends without `turn_complete`. The deltas you saw are enough to
  construct an assistant message; treat it as if the turn had
  finished with `stop_reason: "stop"`.

Neither is wired by default — the recipe lets the partial output go.

## Triggers — anything that can be a Deferred resolution

- **UI stop button.** `Deferred.succeed(abort, undefined)` from the
  click handler.
- **New user message.** Listen on a queue; on first message,
  complete the deferred.
- **Deadline.** `Effect.sleep("30 seconds").pipe(Effect.zipRight(Deferred.succeed(abort, undefined)))`.
- **AbortSignal from outside.** `Effect.callback` to bridge a Web
  `AbortSignal` into the deferred.

## Difference from pause-resume

- **Mid-stream abort** = the _current turn_ is killed; subsequent
  iterations of the loop don't run because the stream itself is
  interrupted.
- **Pause-resume** = the _next iteration_ parks on a latch; the
  current turn finishes naturally first.

Use abort for "stop now," pause for "wait between turns."

## See also

- Recipe source: `recipes/mid-stream-abort/index.ts`
- For pausing the loop between turns: `effect-uai-pause-resume`
- For long-lived chat agents that may need this: `effect-uai-agentic-loop`
