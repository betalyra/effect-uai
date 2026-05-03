---
title: Basic usage
description: A streaming, tool-using conversation built from `loop` and the OpenAI Responses provider.
---

**Scenario.** Ask the model "What time is it in Lisbon and Tokyo right
now?", let it call a `get_current_time` tool, run the tool, and feed the
output back so the model can produce a final answer. Deltas stream as they
arrive.

This is the smallest end-to-end shape an agent built on `effect-uai` takes:
state is a plain record, the body is a `Stream`, and the loop continues
until the model stops asking for tools.

## What it shows

- Defining a tool with `Tool.make` and an Effect `Schema` for its input.
- Projecting tools to provider-shaped descriptors with `Tool.toDescriptors`.
- Driving a turn with `Responses.streamTurn` and piping the raw delta
  stream through `Loop.streamUntilComplete` to forward deltas to the
  consumer and decide what to do once the turn lands.
- Running every requested tool with `Toolkit.executeAll`, which returns
  a `Stream<ToolEvent>` of structured `ToolResult`s.
- Threading those results into next-state via `Toolkit.nextStateFrom`,
  applying `toFunctionCallOutput` at the wire boundary.
- Ending the loop with `Loop.stop` when the model produced its final
  message.

## The loop, in shape

```ts
pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses

      return oai
        .streamTurn({ history: state.history, model: "gpt-5.4-mini", tools })
        .pipe(
          streamUntilComplete<State, ToolEvent>((turn) =>
            Effect.sync(() => {
              const next = Turn.cursor(state, turn)
              const calls = Turn.functionCalls(turn)
              if (calls.length === 0) return stop

              const events = Toolkit.executeAll(toolkit.tools, calls)
              return Toolkit.nextStateFrom(events, (results) => ({
                ...next,
                history: [...next.history, ...results.map(toFunctionCallOutput)],
                index: state.index + 1,
              }))
            }),
          ),
        )
    }),
  ),
)
```

`Turn.cursor(state, turn)` extends `state.history` with `turn.items` and
stamps the turn. `Toolkit.executeAll` runs every requested tool
concurrently, streaming intermediates from streaming tools and a
terminal `Output` per call. `Toolkit.nextStateFrom` collects every
`ToolResult` and hands them to the builder for next-state construction;
`toFunctionCallOutput` is the one place structured `ToolResult`s become
wire-shaped strings. `Loop.stop` ends the loop.

If the upstream ends without a `turn_complete`, the resulting stream
fails with `AiError.IncompleteTurn` - catch it via `Stream.catchTag`
if you want to recover.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-usage/run.ts
```

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-usage/index.ts).
