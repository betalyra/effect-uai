---
title: Auto-compaction
description: Summarize history when turn count or token budget is exceeded.
---

# Recipe: Auto memory compaction

**Scenario.** A multi-turn conversation grows. Once the running history
crosses a turn or token budget, summarize all but the last few items via
the model and replace them with the summary. Then keep going.

The driver here is a queue of pending user prompts: after each assistant
turn the body injects the next prompt into the history; when the queue is
empty, the loop stops. This keeps the recipe focused on the compaction
mechanic itself rather than tool-calling.

## What it shows

- Threading recipe-defined fields through state (`turnIndex`,
  `cumulativeInputTokens`, `pendingPrompts`) - the loop primitive doesn't
  care what the state record looks like.
- Branching the loop body on a state predicate (`shouldCompact`) to take
  one of two paths in a given iteration: a normal turn, or a compaction
  step.
- Issuing a separate `Responses.streamTurn` _inside_ the body (the
  compaction call) and using its result to rewrite history before the
  next iteration.
- Using `Turn.assistantMessages(turn)` to extract the model's textual
  response from the assembled `Turn`.

## The two branches

```ts
loop((state) =>
  Effect.gen(function* () {
    const oai = yield* Responses

    if (shouldCompact(state)) {
      // Compaction step: summarize the early history, replace it.
      // Cheap/fast model for the summarization, even though normal turns
      // below run on the bigger one.
      const toCompact = state.history.slice(0, -KEEP_RECENT_ITEMS)
      return oai
        .streamTurn({
          history: [...toCompact, Items.userText("Summarize the conversation above...")],
          model: "gpt-5.4-mini",
          tools: [],
          reasoning: { effort: "low" },
        })
        .pipe(
          streamUntilComplete((turn) =>
            Effect.sync(() =>
              nextAfter(Stream.empty, withSummary(state /* extract text from turn */)),
            ),
          ),
        )
    }

    // Normal turn: bigger model, stream a response, inject the next user prompt or stop.
    return oai
      .streamTurn({ history: state.history, model: "gpt-5.4", tools: [] })
      .pipe(
        streamUntilComplete((turn) =>
          Effect.sync(() => {
            const next = advance(state, turn)
            if (state.pendingPrompts.length === 0) return stop
            const [nextPrompt, ...rest] = state.pendingPrompts
            return nextAfter(Stream.empty, {
              ...next,
              history: [...next.history, Items.userText(nextPrompt!)],
              pendingPrompts: rest,
            })
          }),
        ),
      )
  }),
)
```

## Beyond a single loop: across user sessions

The recipe compacts within one loop invocation - one SDK process, one
in-memory `State`. Real chat applications usually have a different shape:
each user message is a fresh request, the agent runs a short loop, and
the conversation history is _persisted_ between requests (database, KV
store, file). Compaction at that scale is the same mechanism applied at
a different boundary.

The pieces:

- **Persist `state.history`** (and any tracking fields you care about,
  like `cumulativeInputTokens`) when a session-level loop ends. `Item`
  is JSON-serializable, so this is `JSON.stringify(history)` plus a row
  in your storage layer keyed by conversation id.
- **Hydrate** on the next request: load the row, build the loop's
  `initial` state from it, run the agent loop for that request, save
  the resulting state at the end.
- **Decide when to compact**. Three reasonable points:
  - _Lazy, at load time._ If the hydrated history exceeds your budget,
    run a single compaction `streamTurn` _before_ starting the agent
    loop, then continue with the compacted history.
  - _Eager, at save time._ When the loop finishes a request, check the
    budget; compact and persist the smaller history.
  - _Background._ After the user-facing response returns, kick off
    compaction asynchronously and overwrite the stored history. Best
    for latency-sensitive UIs.

```ts
// Sketch - per request:
const stored = yield* loadHistory(conversationId)
const start: State = { history: stored, /* ... */ }

const ready = shouldCompact(start)
  ? yield* compact(start) // same summarize-via-streamTurn shape as the recipe
  : start

const finalState = yield* Stream.runFold(
  pipe(ready, loop(/* body */)),
  ready,
  /* track final state from emitted Cursor or by other means */,
)

yield* saveHistory(conversationId, finalState.history)
```

## Tuning knobs

- `MAX_TURNS` / `MAX_INPUT_TOKENS` - when compaction fires.
- `KEEP_RECENT_ITEMS` - how many trailing items survive verbatim.
- The summarization prompt and model - swap for a cheaper model, change
  the instruction, etc.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/auto-compaction/index.ts
```

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/auto-compaction/index.ts).
