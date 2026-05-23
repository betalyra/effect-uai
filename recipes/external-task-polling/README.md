---
title: External task polling
description: Coordinate an agent with a long-running external task using a Deferred and a forked polling fiber.
source: recipes/external-task-polling
icon: PiArrowsClockwise
---

Pause an agent loop until an external task completes, with no busy-waiting
inside the loop body.

An agent triggers a CI pipeline deploy via a tool call. The pipeline takes
an unknown amount of time — could be seconds, could be minutes. Rather
than blocking a model turn or polling inline, the recipe forks a
dedicated polling fiber that repeatedly checks pipeline status and
resolves a `Deferred` when a terminal state is reached. The main agent
loop awaits that `Deferred` at the top of the next iteration.

## What it shows

- Using `Deferred` to coordinate a main agent fiber with a background
  polling fiber. The deferred is a one-shot signal: set once by the
  poller, awaited once by the agent.
- `forkPipelinePoller` as a self-contained primitive: create the
  `Deferred`, fork the polling fiber, return the `Deferred` for the
  caller to await.
- A side-channel `Ref` that bridges the tool's `run` function (which
  forks the poller) with the loop body (which captures the `Deferred`
  into the next state).
- Polling with `Effect.repeat` + `Schedule.spaced`, stopping on a
  predicate via the `until` option.

## The fork-and-return pattern

```ts
export const forkPipelinePoller = (
  pipelineId: string,
  checkStatus: (id: string) => Effect.Effect<PipelineStatus>,
  interval: Duration.Input = "2 seconds",
): Effect.Effect<Deferred.Deferred<PipelineResult>> =>
  Effect.gen(function* () {
    const signal = yield* Deferred.make<PipelineResult>()
    yield* Effect.forkDetach(pollPipeline(pipelineId, checkStatus, signal, interval))
    return signal
  })
```

The caller gets back a `Deferred` it can await at any point. The polling
fiber is a child of the current scope — if the agent fiber is
interrupted, the poller is interrupted too. No leaked fibers.

## Coordination inside the loop

```ts
loop((state) =>
  Effect.gen(function* () {
    // Block until any pending pipeline resolves
    const history = yield* Option.match(state.pendingPipeline, {
      onNone: () => Effect.succeed(state.history),
      onSome: (signal) =>
        Deferred.await(signal).pipe(
          Effect.map((r) => [
            ...state.history,
            Items.userText(`Pipeline ${r.pipelineId} completed with status: ${r.status}`),
          ]),
        ),
    })

    // ... normal model turn
  }),
)
```

When `pendingPipeline` is `None`, the loop runs a model turn immediately.
When it's `Some(deferred)`, the loop blocks until the polling fiber
resolves it — no provider call is open, no HTTP connection is held.

## Deferred vs Latch

The [pause-resume](../pause-resume/) recipe uses a `Latch` for
open/close gating. A `Deferred` is the right choice here because the
signal is **one-shot**: the pipeline finishes exactly once. A `Latch`
can be opened and closed repeatedly — overkill for a single completion
event, and it doesn't carry a result value.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/external-task-polling/index.ts).
