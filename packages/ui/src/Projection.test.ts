import type * as Items from "@effect-uai/core/Items"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as ToolOutput from "@effect-uai/core/ToolOutput"
import * as Turn from "@effect-uai/core/Turn"
import { describe, expect, it } from "@effect/vitest"
import { Effect, pipe, Result, Schema, Stream } from "effect"
import * as Projection from "./Projection.js"
import type { RunEvent } from "./RunEvent.js"
import * as UiContract from "./UiContract.js"

class CityNotFound extends Schema.TaggedError<CityNotFound>()("CityNotFound", {
  city: Schema.String,
}) {}

const getWeather = Tool.make({
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ city: Schema.String, observedAt: Schema.DateFromString }),
  failureSchema: CityNotFound,
  run: ({ city }) =>
    city === "Atlantis"
      ? Effect.fail(new CityNotFound({ city }))
      : Effect.succeed({ city, observedAt: new Date("2026-01-01T12:00:00.000Z") }),
})
const search = Tool.make({
  name: "search",
  description: "Search.",
  inputSchema: Tool.noInput,
  outputSchema: Schema.Struct({ hits: Schema.Number }),
  run: () => Stream.make({ hits: 1 }, { hits: 3 }),
})
const toolkit = Toolkit.make(getWeather, search)
const contract = UiContract.make({ tools: [getWeather, search] })

const usage = { input_tokens: 5, output_tokens: 5 }
const callTurn = (calls: ReadonlyArray<readonly [string, string, string]>): Turn.Turn => ({
  stop_reason: "tool_calls",
  usage,
  items: calls.map(([call_id, name, args]) => ({
    type: "function_call",
    call_id,
    name,
    arguments: args,
  })),
})
const answerTurn: Turn.Turn = {
  stop_reason: "stop",
  usage,
  items: [
    { type: "reasoning", summary: "Weather tool says 19.4." },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
  ],
}

type State = { readonly history: ReadonlyArray<Items.HistoryItem> }

const runLoop = (turns: ReadonlyArray<Turn.Turn>) => {
  const { service } = MockProvider.make(turns)
  const initialState: State = { history: [] }
  return pipe(
    initialState,
    loop((state: State) =>
      service.streamTurn({ history: state.history, model: "mock", tools: toolkit }).pipe(
        onTurnComplete((turn) =>
          Effect.sync(() => {
            const calls = Turn.getToolCalls(turn)
            return calls.length === 0
              ? stop()
              : Toolkit.run(toolkit, calls, { concurrency: 1 }).pipe(
                  Toolkit.next(toolkit, state, turn),
                )
          }),
        ),
      ),
    ),
    Projection.toRunEvents({ contract }),
    Stream.runCollect,
  )
}

describe("Projection.toRunEvents", () => {
  it.effect("projects a tool loop: steps per turn, tool lifecycle, encoded outcomes", () =>
    Effect.gen(function* () {
      const events = yield* runLoop([
        callTurn([
          ["c1", "get_weather", `{"city":"Lisbon"}`],
          ["c2", "get_weather", `{"city":"Atlantis"}`],
        ]),
        answerTurn,
      ])
      expect(events.filter((e) => e.type === "tool-result")).toEqual<ReadonlyArray<RunEvent>>([
        {
          type: "tool-result",
          callId: "c1",
          name: "get_weather",
          result: {
            _tag: "Success",
            value: { city: "Lisbon", observedAt: "2026-01-01T12:00:00.000Z" },
          },
        },
        {
          type: "tool-result",
          callId: "c2",
          name: "get_weather",
          result: { _tag: "Failure", error: { _tag: "CityNotFound", city: "Atlantis" } },
        },
      ])
      expect(events.map((e) => e.type)).toEqual([
        "step-started",
        "tool-call-started",
        "tool-call-started",
        "tool-call-ready",
        "tool-call-ready",
        "step-finished",
        "tool-result",
        "tool-result",
        "step-started",
        "reasoning-started",
        "text-delta",
        "step-finished",
      ])
    }),
  )

  it.effect("projects a streaming tool's values as partials before its result", () =>
    Effect.gen(function* () {
      const events = yield* runLoop([callTurn([["s1", "search", "{}"]]), answerTurn])
      expect(events.filter((e) => e.type === "tool-partial" || e.type === "tool-result")).toEqual<
        ReadonlyArray<RunEvent>
      >([
        { type: "tool-partial", callId: "s1", name: "search", value: { hits: 1 } },
        { type: "tool-partial", callId: "s1", name: "search", value: { hits: 3 } },
        {
          type: "tool-result",
          callId: "s1",
          name: "search",
          result: { _tag: "Success", value: { hits: 3 } },
        },
      ])
    }),
  )

  it.effect("projects a history item an app closed itself from its parts", () =>
    Effect.gen(function* () {
      const cancelled = yield* ToolOutput.failure(
        { call_id: "c1" },
        ToolOutput.CoreError,
        new ToolOutput.Cancelled({ message: "user moved on" }),
      )
      const events = yield* Stream.fromIterable<Projection.Source>([
        Turn.TurnEvent.TurnComplete({ turn: callTurn([["c1", "get_weather", "{}"]]) }),
        cancelled,
      ]).pipe(Projection.toRunEvents({ contract }), Stream.runCollect)
      expect(events.at(-1)).toEqual<RunEvent>({
        type: "tool-result",
        callId: "c1",
        name: "get_weather",
        result: { _tag: "Failure", error: { _tag: "Cancelled", message: "user moved on" } },
      })
    }),
  )

  it.effect("fails the stream when a value doesn't fit its contract schema", () =>
    Effect.gen(function* () {
      const output: Projection.Source = {
        _tag: "Output",
        call_id: "c1",
        tool: "search",
        result: Result.succeed({ hits: "many" }),
      }
      const error = yield* Effect.flip(
        Stream.make(output).pipe(Projection.toRunEvents({ contract }), Stream.runCollect),
      )
      expect(error._tag).toBe("SchemaError")
    }),
  )

  it.effect("projects a refusal as refusal-delta, not as text", () =>
    Stream.make(
      Turn.TurnEvent.RefusalDelta({ text: "I can't help with that." }),
      Turn.TurnEvent.TurnComplete({ turn: { stop_reason: "refusal", usage, items: [] } }),
    ).pipe(
      Projection.toRunEvents({ contract }),
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
