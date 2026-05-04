---
name: effect-uai-pause-resume
description: Use when the user wants to soft-pause the agent loop between turns (no provider call held open) and resume later — e.g. cooldown after rate-limit, manual UI pause button, scheduled gating. State threads through naturally; resume picks up exactly where pause left off, no checkpointing needed.
license: MIT
---

# effect-uai pause-resume

Soft pause/resume of an in-flight agent loop using `Latch`. The body
waits on the latch before each iteration; closing it pauses the loop
(no new `streamTurn` is initiated, no HTTP connection held), opening
it resumes. State threads through the loop naturally, so resume picks
up exactly where pause left off — no checkpoint to write.

Reach for this when the user says any of:

- "Pause the agent for X seconds and resume"
- "Manual pause button between turns"
- "Cool down between iterations"

## The mechanism

One `Latch.await` at the top of the loop body is the entire pause.

```ts
import { Effect, Latch, Ref, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { loop, nextAfter, stop, streamUntilComplete } from "@effect-uai/core/Loop"

const conversation = (
  pauseLatch: Latch.Latch,
  turnsCompleted: Ref.Ref<number>,
) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        // Pause point: returns immediately if open, blocks if closed.
        yield* Latch.await(pauseLatch)

        const oai = yield* Responses
        return oai
          .streamTurn({ history: state.history, model: "gpt-5.4-mini" })
          .pipe(
            streamUntilComplete((turn) =>
              Effect.gen(function* () {
                yield* Ref.update(turnsCompleted, (n) => n + 1)
                const next = advance(state, turn)
                if (next.pendingPrompts.length === 0) return stop
                const [nextPrompt, ...rest] = next.pendingPrompts
                return nextAfter(Stream.empty, {
                  ...next,
                  history: [...next.history, Items.userText(nextPrompt!)],
                  pendingPrompts: rest,
                })
              }),
            ),
          )
      }),
    ),
  )
```

## Controller (UI button, signal handler, scheduler)

```ts
const pauseController = (
  pauseLatch: Latch.Latch,
  turnsCompleted: Ref.Ref<number>,
) =>
  Effect.gen(function* () {
    // Wait for the trigger condition (e.g. a button press, N turns done, ...)
    yield* Effect.repeat(
      Effect.gen(function* () {
        const n = yield* Ref.get(turnsCompleted)
        return n >= PAUSE_AFTER_TURN
      }),
      { until: (done) => done },
    )

    yield* Effect.logInfo("pause - holding")
    yield* Latch.close(pauseLatch)

    yield* Effect.sleep("30 seconds")

    yield* Effect.logInfo("resume")
    yield* Latch.open(pauseLatch)
  })
```

Run the controller in a forked fiber alongside the conversation
fiber.

## Why a latch and not a checkpoint?

Pause/resume in this shape is **soft**: the program is still running,
the fiber is just parked. State threads through `loop` naturally
(`nextAfter(state)`), so resume picks up exactly where it left off
without writing or reading a checkpoint.

For *hard* pause (process exits, agent resumes hours later), persist
`state.history` and rebuild the loop's `initial` from it — the same
hydration pattern as `effect-uai-auto-compaction`.

## Wiring it up

```ts
const program = Effect.gen(function* () {
  const pauseLatch = yield* Latch.make(true) // start open
  const turnsCompleted = yield* Ref.make(0)

  yield* Effect.forkChild(pauseController(pauseLatch, turnsCompleted))
  yield* Stream.runDrain(conversation(pauseLatch, turnsCompleted))
})
```

## See also

- Recipe source: `recipes/pause-resume/index.ts`
- For terminating mid-stream entirely: `effect-uai-mid-stream-abort`
- For long-lived chat agents: `effect-uai-agentic-loop`
