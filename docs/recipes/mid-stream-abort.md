---
title: Mid-stream abort
description: Cancel an in-flight streamTurn cleanly via Stream.interruptWhen, tearing down the upstream HTTP request.
---

# Recipe: Mid-stream abort

**Scenario.** A turn is mid-generation - text deltas are arriving from the
provider - and something external (user clicks "stop", a new prompt
arrives, a deadline elapses) needs to cancel it. The upstream HTTP
connection must close, the loop must end cleanly, and any partial deltas
already emitted are kept.

This is a one-line addition to a normal loop: pipe the conversation
stream through `Stream.interruptWhen(Deferred.await(abort))`. When the
deferred completes, the stream interrupts, its scope closes, and
Effect's structured concurrency tears down the HTTP response - which
signals `AbortController` on the underlying `fetch` so the TCP
connection drops.

## What it shows

- Wiring an external trigger (`Deferred<void>`) to a running stream
  with `Stream.interruptWhen`. Any effect that completes will work
  here - a `Promise`, a wall-clock timer, an event from a queue.
- The cleanup chain runs end-to-end: the `Stream.ensuring` finalizer
  on the provider's `streamTurn` fires when the consumer interrupts.
  In production this is what the HTTP client uses to call
  `AbortController.abort()`.
- Partial deltas that already crossed the boundary stay with the
  consumer. No `turn_complete` is emitted because the turn never
  finished, so the recipe's normal completion path (advance state /
  stop) doesn't run.

## The pattern

```ts
const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses
      return oai
        .streamTurn(state.history, {})
        .pipe(streamUntilComplete(() => Effect.sync(() => stop)))
    }),
  ),
)

const abort = yield* Deferred.make<void>()

yield* Stream.runForEach(
  conversation.pipe(Stream.interruptWhen(Deferred.await(abort))),
  (event) => /* log delta, log completion, ... */,
)
```

The trigger lives outside the loop; in the demo a forked fiber sleeps
then completes the deferred. Replace that with whatever fits your app -
a UI signal, a `Queue.take`, an `AbortSignal` bridged into Effect via
`Effect.async`.

## State and partial completions

The recipe's body never sees a `turn_complete` when abort fires, so
`state` stays at its pre-turn value. If you need the partial assistant
text to survive abort, two options:

- **Capture deltas as they stream** - keep a running buffer in a `Ref`
  outside the loop. The interrupted stream still emitted them, so they
  land in the buffer before the abort.
- **Synthesize a partial `Turn`** in the consumer when the stream ends
  without `turn_complete`. The deltas you saw are enough to construct an
  assistant message; treat it as if the turn had finished with
  `stop_reason: "stop"`.

Neither is wired here - the demo just logs deltas and lets the partial
output go.

## Why no `reasoning.effort`

The demo asks for streamed text and aborts on a wall clock. With
`reasoning.effort` set, the model thinks first and only then emits
output tokens, so a short abort window can land before any delta has
crossed the wire. Dropping the reasoning request makes deltas start
immediately and the abort lands mid-stream where it should.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/mid-stream-abort/index.ts
```

You'll see a stream of `delta` log lines, then `abort fired after 3
seconds`, then `loop ended`. No `turn_complete` line.

The full source lives next to this README at
[`recipes/mid-stream-abort/index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/mid-stream-abort/index.ts).
