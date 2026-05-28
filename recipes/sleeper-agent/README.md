---
title: Sleeper agent
description: Coordinate an agent with a long-running external task using a Deferred and a forked polling fiber.
source: recipes/sleeper-agent
icon: PiDetective
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
  `Deferred`, fork the polling fiber into an explicit scope with
  `Effect.forkIn`, return the `Deferred` for the caller to await.
- `Deferred.into` so the awaiter is **always** released — success,
  check failure, or interruption all complete the `Deferred`.
- A side-channel `Queue` that bridges the tool's `run` function (which
  forks the poller) with the loop body (which drains the pending
  `Deferred`s at the top of the next turn). A queue keeps every poller
  even when the model triggers several deploys in one turn.
- Polling with `Effect.repeat` + `Schedule.spaced`, stopping on a
  predicate via the `until` option, with `Schema.is` deriving the
  terminal-state guard from a single `Schema.Literals` source of truth.

## The fork-and-return pattern

```ts
export const forkPipelinePoller = (
  pipelineId: string,
  checkStatus: CheckStatus,
  scope: Scope.Scope,
  interval: Duration.Input = "2 seconds",
) =>
  Effect.gen(function* () {
    const signal = yield* Deferred.make<PipelineResult, PipelineCheckError>()
    yield* Effect.forkIn(pollPipeline(pipelineId, checkStatus, signal, interval), scope)
    return signal
  })
```

The caller gets back a `Deferred` it can await at any point. The polling
fiber is forked into the scope passed as an explicit value — when that
scope closes, the poller is interrupted too. No leaked fibers. The poll
effect ends in `Deferred.into(signal)`, so whether the pipeline reaches a
terminal state or `checkStatus` fails, the `Deferred` is completed and
the awaiter is never left hanging.

## Coordination inside the loop

```ts
loop((state) =>
  Effect.gen(function* () {
    // Drain (non-blocking) any pipelines forked in prior turns and block
    // on each before the next turn. `Queue.clear` returns immediately with
    // an empty array when nothing is pending; `takeAll` would block.
    const signals = yield* Queue.clear(pending)
    const messages = yield* Effect.forEach(
      signals,
      (signal) =>
        Deferred.await(signal).pipe(
          Effect.map((r) =>
            Items.userText(`Pipeline ${r.pipelineId} completed with status: ${r.status}`),
          ),
          Effect.catch((e) =>
            Effect.succeed(
              Items.userText(`Pipeline ${e.pipelineId} status check failed (${e._tag})`),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    )
    const history = [...state.history, ...messages]

    // ... normal model turn
  }),
)
```

When the queue is empty the loop runs a model turn immediately. When a
pipeline is pending it blocks until the polling fiber resolves the
`Deferred` — no provider call is open, no HTTP connection is held. Tool
results are folded back into history with `Toolkit.continueWith` +
`Turn.appendTurn`, the same pattern the other tool-using recipes share.

## Deferred vs Latch

The [pause-resume](../pause-resume/) recipe uses a `Latch` for
open/close gating. A `Deferred` is the right choice here because the
signal is **one-shot**: the pipeline finishes exactly once. A `Latch`
can be opened and closed repeatedly — overkill for a single completion
event, and it doesn't carry a result value.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/sleeper-agent/index.ts).
