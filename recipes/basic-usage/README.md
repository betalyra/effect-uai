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
- Driving a turn with `Responses.streamTurn` and piping the raw delta
  stream through `Loop.streamUntilComplete` to forward deltas to the
  consumer and decide what to do once the turn lands.
- Continuing the loop with `Loop.nextAfter` after running tools, or
  ending it with `Loop.stop` when the model produced its final message.
- The downstream consumer sees the natural protocol shapes
  (`Turn.TurnDelta`, `Items.FunctionCallOutput`) and pattern-matches on
  the existing `type` discriminator. No recipe-defined event taxonomy.

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
          streamUntilComplete((turn) =>
            Effect.gen(function* () {
              const next = Turn.cursor(state, turn)
              const calls = Turn.functionCalls(turn)
              if (calls.length === 0) return stop

              const outputs = yield* Toolkit.executeAllSafe(toolkit, calls)
              return nextAfter(Stream.fromIterable(outputs), {
                ...next,
                history: [...next.history, ...outputs],
                index: state.index + 1,
              })
            }),
          ),
        )
    }),
  ),
)
```

`Turn.cursor(state, turn)` extends `state.history` with `turn.items` and
stamps the turn. `Loop.stop` is a one-element stream that ends the loop;
`Loop.nextAfter(s, state)` emits the values in `s` then advances with
the new state.

If the upstream ends without a `turn_complete`, the resulting stream
fails with `AiError.IncompleteTurn` - catch it via `Stream.catchTag`
if you want to recover.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-usage/index.ts
```

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-usage/index.ts).
