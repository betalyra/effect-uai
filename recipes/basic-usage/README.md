---
title: Basic usage
description: "Build the core agent harness: state, stream, tools, and explicit continuation."
source: recipes/basic-usage
---

This is the shape everything else in `effect-uai` grows from.

A conversation is not a framework-owned agent. It is a loop over your own
state. Each iteration streams one model turn. When the turn completes, you
inspect the data, run any requested tools, append the tool outputs to history,
and decide whether to continue or stop.

**Scenario.** Ask the model "What time is it in Lisbon and Tokyo right now?",
let it call a `get_current_time` tool, run the tool, and feed the output back
so the model can produce a final answer. Deltas stream the whole time.

## The Harness

The core harness has four moving parts:

- **State is a record.** Here it is just `{ history, index }`.
- **One turn is a stream.** Provider deltas flow out immediately.
- **Tools are Effects.** The model asks; you validate, execute, and append
  structured results.
- **Continuation is explicit.** No lifecycle hook decides the next step for
  you.

## The Loop In Shape

```ts
pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const lm = yield* LanguageModel

      return lm.streamTurn({ history: state.history, model: "gpt-5.4-mini", tools: toolkit }).pipe(
        onTurnComplete((turn) =>
          Effect.sync(() => {
            const calls = Turn.getToolCalls(turn)
            // No tool calls means the model produced its final answer.
            if (calls.length === 0) return stop()

            // Append the model's tool_call items and the matching outputs.
            return Toolkit.run(toolkit, calls).pipe(
              Toolkit.continueWithResults(
                Toolkit.appendToolResults({ ...state, index: state.index + 1 }, turn),
              ),
            )
          }),
        ),
      )
    }),
  ),
)
```

Read it from top to bottom:

- `streamTurn` starts one model turn from the current history.
- `onTurnComplete` forwards deltas while the turn is in flight, then
  hands you the assembled `Turn`.
- `Turn.getToolCalls(turn)` extracts what the model asked tools to do.
- `Toolkit.run` runs those calls and streams `ToolEvent`s.
- `continueWithResults` collects terminal `ToolResult`s and feeds them into the
  continuation.
- `Toolkit.appendToolResults` appends both model items and tool outputs to
  history.
- `stop()` ends the loop when the model no longer asks for tools.

The important part is not the helper names. The important part is that every
transition is visible as ordinary Effect code. Want fallback? Catch provider
errors around the turn stream. Want approval? Split tool calls before
`Toolkit.run`. Want compaction? Transform `state.history` before the next
iteration.

If the upstream ends without a `TurnComplete`, the resulting stream
fails with `AiError.IncompleteTurn`. Catch it via `Stream.catchTag`
if you want to recover.

## What This Generalizes To

This same harness is used by the rest of the recipes:

- tool approval gates calls before `Toolkit.run`;
- streaming tools add `Progress` events without changing the loop;
- model fallback catches provider errors and continues with a new layer;
- compaction rewrites history before the next turn.

A common next step is [Structured output](/recipes/structured-output/):
the same turn, but the model returns a schema-validated value instead of a
freeform answer.

## Run it

Runs against any OpenAI-compatible gateway. Pick it with `--base-url` / `--model`
/ `--provider`; the key comes from `LLM_API_KEY`. Requesty with Kimi K3:

```sh
LLM_API_KEY=... pnpm tsx recipes/basic-usage/run-node.ts \
  --base-url https://router.requesty.ai/v1 --model moonshotai/kimi-k3 --provider requesty
```

`recipe.ts` is the agent loop, `app.ts` wires the provider + rendering, and
`run-node.ts` / `run-bun.ts` / `run-deno.ts` attach the platform `HttpClient`.
