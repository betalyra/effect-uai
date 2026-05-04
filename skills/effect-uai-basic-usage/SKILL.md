---
name: effect-uai-basic-usage
description: Use when the user wants the canonical effect-uai agent loop — stream a model turn, run any tools the model asks for, append outputs, continue until the model produces a final answer. The starting shape every other recipe is a variation of.
license: MIT
---

# effect-uai basic-usage

The canonical agent loop: stream one model turn, run any tools the
model asks for, append the outputs, and continue until the model
produces a final answer.

Reach for this when the user says any of:

- "I want to build a basic agent / chat with tools"
- "How do I run a tool when the model asks for one?"
- "Show me the standard agent loop in effect-uai"

## The loop body

```ts
import { Effect, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"
import * as Tool from "@effect-uai/core/Tool"
import type { ToolEvent } from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { Responses } from "@effect-uai/responses"

interface State {
  readonly history: ReadonlyArray<Items.Item>
}

const initial: State = {
  history: [Items.userText("What time is it in Lisbon and Tokyo right now?")],
}

const tools: ReadonlyArray<Tool.AnyKindTool> = [/* getCurrentTime, ... */]
const descriptors = Tool.toDescriptors(tools)

export const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses
      return oai
        .streamTurn({
          history: state.history,
          model: "gpt-5.4-mini",
          tools: descriptors,
          reasoning: { effort: "low" },
        })
        .pipe(
          streamUntilComplete<State, ToolEvent>((turn) =>
            Effect.sync(() => {
              const calls = Turn.functionCalls(turn)

              // No tool calls -> assistant is done.
              if (calls.length === 0) return stop

              // Tool calls -> execute, append outputs, loop again.
              const events = Toolkit.executeAll(tools, calls)
              return Toolkit.nextStateFrom(events, (results) =>
                Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
              )
            }),
          ),
        )
    }),
  ),
)
```

## Defining a tool

```ts
import { DateTime, Effect, Option, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"

const getCurrentTime = Tool.make({
  name: "get_current_time",
  description:
    "Look up the current local time for an IANA timezone, e.g. 'Europe/Lisbon'.",
  inputSchema: Tool.fromEffectSchema(
    Schema.Struct({ timezone: Schema.String }),
  ),
  run: ({ timezone }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        DateTime.setZoneNamed(now, timezone).pipe(
          Option.match({
            onNone: () => Effect.fail(new Error(`Invalid timezone: ${timezone}`)),
            onSome: (zoned) =>
              Effect.succeed({ timezone, iso: DateTime.formatIsoZoned(zoned) }),
          }),
        ),
      ),
    ),
  strict: true,
})
```

The `run` Effect can fail; failures get wrapped into a structured
`ToolResult.Failure` and forwarded to the model in history so the
model can self-correct.

## Running it

```ts
import { Config, Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as responsesLayer } from "@effect-uai/responses"

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const runtime = apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer))

await Effect.runPromise(
  Stream.runDrain(conversation).pipe(Effect.provide(runtime)),
)
```

## Anti-patterns

- **Don't manually build `function_call_output` items.** Use
  `Toolkit.executeAll` + `toFunctionCallOutput` so output formats stay
  provider-correct.
- **Don't run tools outside the loop body.** They need to be part of
  the same iteration so their outputs are visible in `state.history`
  before the next turn.
- **Don't forget `tools: descriptors` on the request.** Without it the
  model can't call your tools at all; it'll just answer in prose.

## See also

- Recipe source: `recipes/basic-usage/index.ts`
- For typed JSON output: `effect-uai-structured-output`
- For human approval before tools run: `effect-uai-tool-call-approval`
- For multi-message chat with a queue: `effect-uai-agentic-loop`
