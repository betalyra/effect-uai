---
title: Pause and resume
description: Soft pause/resume of an in-flight agent loop using Effect's Latch.
---

Pause between turns, not inside provider magic.

An agent loop is running. Something - a user clicking "pause", a rate-limit
cool-down, an external admin signal - needs to _pause_ the loop without
tearing it down: hold the current state, stop making provider calls, release
HTTP resources. Later, _resume_ and continue from exactly where the pause
landed.

This is **soft pause**: in-process, no persistence. State threads through
the loop as it normally does, so when the latch reopens the next
iteration runs with the held state. There's no checkpoint to write.

## What it shows

- Using `Effect.Latch` as a gate inside the loop body. Closing the
  latch pauses the loop; opening it resumes.
- A pause point that lands _between_ iterations: while the latch is
  closed, no new `streamTurn` is initiated and no HTTP connection is
  held by the SDK.
- An external "controller" fiber that toggles the latch. In the demo
  it's gated on a turn-count threshold via a shared `Ref` so the pause
  lands deterministically. In a real app the trigger is whatever you
  want - a UI button, a signal handler, a timer.

## The pause primitive

```ts
const conversation = (pauseLatch: Latch.Latch, turnsCompleted: Ref.Ref<number>) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        // Pause point: returns immediately if open, blocks until open.
        yield* Latch.await(pauseLatch)

        const oai = yield* Responses
        return oai.streamTurn({ history: state.history, model: "gpt-5.4-mini", tools: [] }).pipe(
          streamUntilComplete((turn) =>
            Effect.gen(function* () {
              yield* Ref.update(turnsCompleted, (n) => n + 1)
              const next = advance(state, turn)
              if (next.pendingPrompts.length === 0) return stop
              const [nextPrompt, ...rest] = next.pendingPrompts
              // Resume continues from this state after the latch opens again.
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

`Latch.await(pauseLatch)` is the entire pause mechanism. While the
latch is open, it returns immediately and the body proceeds normally.
While closed, the body suspends - the previous turn has already
finished and released its HTTP connection, the next turn hasn't started,
and `state` is held in memory exactly where the suspension landed.

The demo's controller pauses after `PAUSE_AFTER_TURN` turns by polling
a shared `Ref<number>` that the body increments. Count-based gating is
deterministic regardless of model latency; a wall-clock controller
(`Effect.sleep("3 seconds")`) would race against generation speed.

## Soft pause vs. cross-process resume

Soft pause (this recipe) keeps state in the running fiber. Tearing
down the process throws state away. If you need pause-resume that
survives a restart, you need persistence - hydrate `initial` from a
checkpoint instead of from a literal, save state at relevant points.
That's a different pattern (closer to the cross-session compaction
section in the auto-compaction recipe).

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/pause-resume/index.ts
```

Watch the timestamps in the log output - you'll see ~5 seconds of
silence between turns 3 and 4 while the controller holds the latch
closed.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/pause-resume/index.ts).
