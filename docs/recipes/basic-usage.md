---
title: Basic usage
description: A streaming, tool-using conversation built from `loop` and the OpenAI Responses provider.
---

# Recipe: Basic usage

**Scenario.** Ask the model "What time is it in Lisbon and Tokyo right
now?", let it call a `get_current_time` tool, run the tool, and feed the
output back so the model can produce a final answer. Deltas stream as they
arrive.

This is the smallest end-to-end shape an agent built on `effect-uai` takes:
state is a plain record, the body is a `Stream`, and the loop continues
until the model stops asking for tools.

## What it shows

- Defining a tool with `Tool.make` and an Effect `Schema` for its input.
- Building a `Toolkit` and projecting it to provider-shaped descriptors with
  `Toolkit.toDescriptors`.
- Driving a turn with `Responses.streamTurn` and turning the raw delta
  stream into loop events with `Turn.streamUntilComplete`.
- Continuing the loop with `Loop.nextAfter` after running tools, or stopping
  with `Loop.stopAfter` when the model produced its final message.
- Forwarding three event shapes downstream - `delta`, `tool_output`,
  `turn_complete` - so the caller can render or log each as it likes.

## The loop, in shape

```ts
loop(initial, (state) =>
  Effect.gen(function* () {
    const oai = yield* Responses
    const deltas = oai.streamTurn(state.history, { tools })

    return Turn.streamUntilComplete(deltas, {
      emit: (delta) => Stream.succeed(value({ type: "delta", delta })),
      onMissing: Effect.fail(/* stream ended without turn_complete */),
      then: (turn) =>
        Effect.gen(function* () {
          const calls = Turn.functionCalls(turn)
          if (calls.length === 0) return stopAfter(turnComplete)

          const outputs = yield* Toolkit.executeAllSafe(toolkit, calls)
          return nextAfter(Stream.concat(turnComplete, toolOutputs), {
            ...state,
            history: [...state.history, ...turn.items, ...outputs],
            index: state.index + 1,
          })
        }),
    })
  }),
)
```

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-usage/index.ts
```

The full source lives next to this README at
[`recipes/basic-usage/index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-usage/index.ts).
