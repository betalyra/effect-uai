import type * as Items from "@effect-uai/core/Items"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { describe, it } from "@effect/vitest"
import { Effect, pipe, Schema, Stream } from "effect"
import { expect } from "vitest"
import * as Projection from "./Projection.js"
import type { RunEvent } from "./RunEvent.js"

const getWeather = Tool.make({
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ city: Schema.String, temperatureC: Schema.Number }),
  run: ({ city }) => Effect.succeed({ city, temperatureC: 19.4 }),
})
const toolkit = Toolkit.make(getWeather)

const usage = { input_tokens: 5, output_tokens: 5 }
const toolTurn: Turn.Turn = {
  stop_reason: "tool_calls",
  usage,
  items: [
    { type: "function_call", call_id: "c1", name: "get_weather", arguments: `{"city":"Lisbon"}` },
  ],
}
const answerTurn: Turn.Turn = {
  stop_reason: "stop",
  usage,
  items: [
    { type: "reasoning", summary: "Weather tool says 19.4." },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "19°C in Lisbon." }],
    },
  ],
}

type State = { readonly history: ReadonlyArray<Items.HistoryItem> }

describe("Projection.toRunEvents", () => {
  it.effect(
    "projects a real tool loop: steps per turn, tool lifecycle, reasoning signal only",
    () =>
      Effect.gen(function* () {
        const { service } = MockProvider.make([toolTurn, answerTurn])
        const initialState: State = { history: [] }
        const events = yield* pipe(
          initialState,
          loop((state: State) =>
            service.streamTurn({ history: state.history, model: "mock", tools: toolkit }).pipe(
              onTurnComplete((turn) =>
                Effect.sync(() => {
                  const calls = Turn.getToolCalls(turn)
                  return calls.length === 0
                    ? stop()
                    : Toolkit.run(toolkit, calls).pipe(
                        Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)),
                      )
                }),
              ),
            ),
          ),
          Projection.toRunEvents(),
          Stream.runCollect,
        )

        expect(events).toEqual<ReadonlyArray<RunEvent>>([
          { type: "step-started" },
          { type: "tool-call-started", callId: "c1", name: "get_weather" },
          { type: "tool-call-ready", callId: "c1", name: "get_weather", input: { city: "Lisbon" } },
          { type: "step-finished", usage },
          {
            type: "tool-result",
            callId: "c1",
            output: { city: "Lisbon", temperatureC: 19.4 },
            isError: false,
          },
          { type: "step-started" },
          { type: "reasoning-started" },
          { type: "text-delta", text: "19°C in Lisbon." },
          { type: "step-finished", usage },
        ])
      }),
  )

  it.effect("projects a refusal as refusal-delta, not as text", () =>
    Stream.make(
      Turn.TurnEvent.RefusalDelta({ text: "I can't help with that." }),
      Turn.TurnEvent.TurnComplete({ turn: { stop_reason: "refusal", usage, items: [] } }),
    ).pipe(
      Projection.toRunEvents(),
      Stream.runCollect,
      Effect.map((events) =>
        expect(events).toEqual<ReadonlyArray<RunEvent>>([
          { type: "step-started" },
          { type: "refusal-delta", text: "I can't help with that." },
          { type: "step-finished", usage },
        ]),
      ),
    ),
  )
})
