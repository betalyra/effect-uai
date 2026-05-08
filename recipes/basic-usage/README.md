---
title: Basic usage
description: "Build the core agent harness: state, stream, tools, and explicit continuation."
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
      const oai = yield* Responses

      return oai.streamTurn({ history: state.history, model: "gpt-5.4-mini", tools }).pipe(
        streamUntilComplete<State, ToolEvent>((turn) =>
          Effect.sync(() => {
            const calls = Turn.functionCalls(turn)
            // No tool calls means the model produced its final answer.
            if (calls.length === 0) return stop

            const events = Toolkit.executeAll(toolkit.tools, calls)
            return Toolkit.nextStateFrom(events, (results) =>
              // Append the model's function_call items and the matching outputs.
              Turn.appendTurn(
                { ...state, index: state.index + 1 },
                turn,
                results.map(toFunctionCallOutput),
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
- `streamUntilComplete` forwards deltas while the turn is in flight, then
  hands you the assembled `Turn`.
- `Turn.functionCalls(turn)` extracts what the model asked tools to do.
- `Toolkit.executeAll` runs those calls and streams `ToolEvent`s.
- `nextStateFrom` collects terminal `ToolResult`s.
- `Turn.appendTurn` appends both model items and tool outputs to history.
- `stop` ends the loop when the model no longer asks for tools.

The important part is not the helper names. The important part is that every
transition is visible as ordinary Effect code. Want fallback? Catch provider
errors around the turn stream. Want approval? Split tool calls before
`executeAll`. Want compaction? Transform `state.history` before the next
iteration.

If the upstream ends without a `turn_complete`, the resulting stream
fails with `AiError.IncompleteTurn` - catch it via `Stream.catchTag`
if you want to recover.

## What This Generalizes To

This same harness is used by the rest of the recipes:

- tool approval gates calls before `executeAll`;
- streaming tools add `Intermediate` events without changing the loop;
- model fallback catches provider errors and continues with a new layer;
- compaction rewrites history before the next turn.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-usage/run.ts
```

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-usage/index.ts).
