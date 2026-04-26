import { Duration, Effect, Fiber, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Items from "../src/Items.js"
import { LanguageModel, streamTurn, turn } from "../src/LanguageModel.js"
import * as Metrics from "../src/Metrics.js"
import * as MockProvider from "../src/providers/MockProvider.js"
import * as Tool from "../src/Tool.js"
import * as Toolkit from "../src/Toolkit.js"
import { functionCalls, type Turn, type TurnDelta } from "../src/Turn.js"

// ---------------------------------------------------------------------------
// Tool — get_weather
// ---------------------------------------------------------------------------

const GetWeatherInput = Schema.Struct({ city: Schema.String })

const getWeather = Tool.make({
  name: "get_weather",
  description: "Look up the current temperature for a city.",
  inputSchema: Tool.fromEffectSchema(GetWeatherInput),
  run: ({ city }) => Effect.succeed({ city, tempC: 18 })
})

const toolkit = Toolkit.make([getWeather])

// ---------------------------------------------------------------------------
// Scripted turns the mock provider will replay, in order.
// ---------------------------------------------------------------------------

const turn1: Turn = {
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Let me check the weather." }]
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: JSON.stringify({ city: "Lisbon" })
    }
  ],
  usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
  stop_reason: "tool_calls"
}

const turn2: Turn = {
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "It's 18°C in Lisbon." }]
    }
  ],
  usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
  stop_reason: "stop"
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PoC — primitives only, no Conversation helper", () => {
  it("happy path: text → tool → text via Stream.paginate directly", async () => {
    const { layer, recorder } = MockProvider.layerWithRecorder([turn1, turn2])

    type State = {
      readonly history: ReadonlyArray<Items.Item>
      readonly index: number
    }
    type Cursor = {
      readonly history: ReadonlyArray<Items.Item>
      readonly turn: Turn
      readonly index: number
    }

    const initial: State = {
      history: [Items.userText("What's the weather in Lisbon?")],
      index: 0
    }

    // The "loop" is right here, fully visible. No helper, no callback.
    // Each iteration: call the LM, append items, run any tools, decide whether
    // to continue. The shape is `Effect<[emit[], Option<nextState>]>`.
    const conversation = Stream.paginate(initial, (state) =>
      turn(state.history).pipe(
        Effect.flatMap((t) => {
          const history = [...state.history, ...t.items]
          const cursor: Cursor = { history, turn: t, index: state.index }
          const calls = functionCalls(t)
          if (calls.length === 0) {
            return Effect.succeed(
              [[cursor], Option.none<State>()] as const
            )
          }
          return Toolkit.executeAll(toolkit, calls).pipe(
            Effect.map((outputs) =>
              [
                [cursor],
                Option.some<State>({
                  history: [...history, ...outputs],
                  index: state.index + 1
                })
              ] as const
            )
          )
        })
      )
    )

    const program = Effect.gen(function* () {
      const cursors = yield* Stream.runCollect(conversation)
      const captured = yield* recorder
      return { cursors, calls: captured.calls }
    })

    const { cursors, calls } = await Effect.runPromise(
      program.pipe(Effect.provide(layer))
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]!.history).toEqual([
      Items.userText("What's the weather in Lisbon?")
    ])

    const secondHistory = calls[1]!.history
    expect(secondHistory).toHaveLength(4)
    expect(secondHistory[3]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1"
    })
    expect(JSON.parse((secondHistory[3] as Items.FunctionCallOutput).output))
      .toEqual({ city: "Lisbon", tempC: 18 })

    expect(cursors).toHaveLength(2)
    expect(cursors[0]!.turn.stop_reason).toBe("tool_calls")
    expect(cursors[1]!.turn.stop_reason).toBe("stop")
    expect(cursors[1]!.history).toHaveLength(5)
    expect((cursors[1]!.history[4] as Items.Message).content[0]).toEqual({
      type: "output_text",
      text: "It's 18°C in Lisbon."
    })
  })

  it("model swap mid-stream via Effect.provideService", async () => {
    // Two mock providers — haiku speaks first, then the assistant calls
    // `upgrade_model` and the next turn is fielded by opus. State carries
    // the current model as a value; we wire it in per-iteration with
    // `Effect.provideService`.

    const haikuTurn: Turn = {
      items: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "This is hard. Let me upgrade."
            }
          ]
        },
        {
          type: "function_call",
          call_id: "u_1",
          name: "upgrade_model",
          arguments: JSON.stringify({ to: "opus" })
        }
      ],
      usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
      stop_reason: "tool_calls"
    }

    const opusTurn: Turn = {
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The answer is 42." }]
        }
      ],
      usage: { input_tokens: 25, output_tokens: 5, total_tokens: 30 },
      stop_reason: "stop"
    }

    const haiku = MockProvider.make([haikuTurn])
    const opus = MockProvider.make([opusTurn])

    // The upgrade tool itself is a no-op — it exists so the LLM has
    // something to "call" to signal the upgrade. The actual swap happens
    // in the step below, which interprets the call.
    const upgradeModel = Tool.make({
      name: "upgrade_model",
      description: "Upgrade the active model.",
      inputSchema: Tool.fromEffectSchema(Schema.Struct({ to: Schema.String })),
      run: ({ to }) => Effect.succeed({ upgraded_to: to })
    })
    const tk = Toolkit.make([upgradeModel])

    type State = {
      readonly history: ReadonlyArray<Items.Item>
      readonly model: typeof haiku.service
      readonly index: number
    }
    type Cursor = {
      readonly history: ReadonlyArray<Items.Item>
      readonly turn: Turn
      readonly modelName: "haiku" | "opus"
      readonly index: number
    }

    const initial: State = {
      history: [Items.userText("What is the meaning of life?")],
      model: haiku.service,
      index: 0
    }

    const conversation = Stream.paginate(initial, (state) =>
      turn(state.history).pipe(
        Effect.provideService(LanguageModel, state.model),
        Effect.flatMap((t) => {
          const history = [...state.history, ...t.items]
          const calls = functionCalls(t)
          const wantsUpgrade = calls.find((c) => c.name === "upgrade_model")
          const cursor: Cursor = {
            history,
            turn: t,
            modelName: state.model === haiku.service ? "haiku" : "opus",
            index: state.index
          }
          if (calls.length === 0) {
            return Effect.succeed([[cursor], Option.none<State>()] as const)
          }
          return Toolkit.executeAll(tk, calls).pipe(
            Effect.map((outputs) =>
              [
                [cursor],
                Option.some<State>({
                  history: [...history, ...outputs],
                  // pure swap: same line you'd update any other state field
                  model: wantsUpgrade ? opus.service : state.model,
                  index: state.index + 1
                })
              ] as const
            )
          )
        })
      )
    )

    const program = Effect.gen(function* () {
      const cursors = yield* Stream.runCollect(conversation)
      const haikuCalls = (yield* haiku.recorder).calls
      const opusCalls = (yield* opus.recorder).calls
      return { cursors, haikuCalls, opusCalls }
    })

    const { cursors, haikuCalls, opusCalls } = await Effect.runPromise(program)

    expect(haikuCalls).toHaveLength(1)
    expect(opusCalls).toHaveLength(1)

    // Cursor 0 was generated by haiku, cursor 1 by opus.
    expect(cursors).toHaveLength(2)
    expect(cursors[0]!.modelName).toBe("haiku")
    expect(cursors[1]!.modelName).toBe("opus")

    // Opus saw the full prior history including the upgrade tool result.
    const opusHistory = opusCalls[0]!.history
    expect(opusHistory).toHaveLength(4)
    expect(opusHistory[2]).toMatchObject({
      type: "function_call",
      name: "upgrade_model"
    })
    expect(opusHistory[3]).toMatchObject({
      type: "function_call_output",
      call_id: "u_1"
    })

    // Final assistant message is the opus response.
    const final = cursors[1]!.history
    expect((final[final.length - 1] as Items.Message).content[0]).toEqual({
      type: "output_text",
      text: "The answer is 42."
    })
  })

  it("tool repair via Effect.catchTag — feed schema error back to the LLM", async () => {
    // The mock first calls get_weather with the wrong arg name (`cityName`
    // instead of `city`). Schema decode fails with ToolError. The step
    // catches that error and feeds it back as a function_call_output with
    // a structured error payload. The mock then "corrects" itself on the
    // next turn and the conversation completes.

    const badTurn: Turn = {
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Looking up Lisbon." }]
        },
        {
          type: "function_call",
          call_id: "call_bad",
          name: "get_weather",
          // wrong arg name — should be `city`
          arguments: JSON.stringify({ cityName: "Lisbon" })
        }
      ],
      usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
      stop_reason: "tool_calls"
    }

    const goodTurn: Turn = {
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Sorry, retrying." }]
        },
        {
          type: "function_call",
          call_id: "call_good",
          name: "get_weather",
          arguments: JSON.stringify({ city: "Lisbon" })
        }
      ],
      usage: { input_tokens: 30, output_tokens: 6, total_tokens: 36 },
      stop_reason: "tool_calls"
    }

    const finalTurn: Turn = {
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "It's 18°C in Lisbon." }]
        }
      ],
      usage: { input_tokens: 40, output_tokens: 6, total_tokens: 46 },
      stop_reason: "stop"
    }

    const { layer, recorder } = MockProvider.layerWithRecorder([
      badTurn,
      goodTurn,
      finalTurn
    ])

    type State = {
      readonly history: ReadonlyArray<Items.Item>
      readonly index: number
    }

    // The repair pattern: per-call, `executeOne` may fail with `ToolError`.
    // Catch it and translate into a `function_call_output` with a payload
    // shaped for the LLM to read. The conversation continues; the model
    // self-corrects on the next turn.
    const safeExecute = (call: Items.FunctionCall) =>
      Toolkit.executeOne(toolkit, call).pipe(
        Effect.catchTag("ToolError", (err) =>
          Effect.succeed(
            Items.functionCallOutput(
              call.call_id,
              JSON.stringify({
                error: "argument_validation_failed",
                tool: err.tool,
                message: err.message
              })
            )
          )
        )
      )

    const conversation = Stream.paginate({
      history: [Items.userText("What's the weather in Lisbon?")],
      index: 0
    } as State, (state) =>
      turn(state.history).pipe(
        Effect.flatMap((t) => {
          const history = [...state.history, ...t.items]
          const cursor = { history, turn: t, index: state.index }
          const calls = functionCalls(t)
          if (calls.length === 0) {
            return Effect.succeed([[cursor], Option.none<State>()] as const)
          }
          return Effect.forEach(calls, safeExecute, {
            concurrency: "unbounded"
          }).pipe(
            Effect.map((outputs) =>
              [
                [cursor],
                Option.some<State>({
                  history: [...history, ...outputs],
                  index: state.index + 1
                })
              ] as const
            )
          )
        })
      )
    )

    const program = Effect.gen(function* () {
      const cursors = yield* Stream.runCollect(conversation)
      const calls = (yield* recorder).calls
      return { cursors, calls }
    })

    const { cursors, calls } = await Effect.runPromise(
      program.pipe(Effect.provide(layer))
    )

    // Provider was called three times: bad, good, final.
    expect(calls).toHaveLength(3)
    expect(cursors).toHaveLength(3)

    // The mock's *second* call shows what the step produced after the bad
    // turn: a function_call_output carrying a structured schema error.
    const histAfterBad = calls[1]!.history
    const errOutput = histAfterBad[histAfterBad.length - 1] as Items.FunctionCallOutput
    expect(errOutput.type).toBe("function_call_output")
    expect(errOutput.call_id).toBe("call_bad")
    const errPayload = JSON.parse(errOutput.output) as {
      error: string
      tool: string
      message: string
    }
    expect(errPayload.error).toBe("argument_validation_failed")
    expect(errPayload.tool).toBe("get_weather")

    // The mock's *third* call shows the corrected tool output appended.
    const histAfterGood = calls[2]!.history
    const goodOutput = histAfterGood[histAfterGood.length - 1] as Items.FunctionCallOutput
    expect(goodOutput.call_id).toBe("call_good")
    expect(JSON.parse(goodOutput.output)).toEqual({
      city: "Lisbon",
      tempC: 18
    })

    // Cursor 2 is the final assistant message, no tool calls.
    expect(cursors[2]!.turn.stop_reason).toBe("stop")
  })

  it("metrics: ttft + tokens-per-second over a TestClock-paced stream", async () => {
    // Five output_text content blocks → five text_delta events from the
    // mock provider. Spaced 100ms apart by `Schedule.spaced`. Plus the
    // terminal `turn_complete` event.
    const pacedTurn: Turn = {
      items: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "tok" },
            { type: "output_text", text: "tok" },
            { type: "output_text", text: "tok" },
            { type: "output_text", text: "tok" },
            { type: "output_text", text: "tok" }
          ]
        }
      ],
      usage: { input_tokens: 0, output_tokens: 5, total_tokens: 5 },
      stop_reason: "stop"
    }

    // The metric pipeline: subscribe to the delta stream, weight each
    // text_delta as 1 token, ignore other deltas. Each emitted point
    // carries running total + rate + elapsed time since stream start.
    const program = Effect.gen(function* () {
      const points = yield* streamTurn([Items.userText("go")]).pipe(
        Metrics.withRate((d: TurnDelta) =>
          d.type === "text_delta" ? 1 : 0
        ),
        Stream.runCollect
      )
      return points
    }).pipe(
      Effect.provide(
        MockProvider.layer([pacedTurn], { deltaInterval: "100 millis" })
      )
    )

    // Pattern recommended by TestClock: fork the program (so it suspends
    // on the scheduled sleeps), advance the virtual clock, then join.
    const driver = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(program)
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    })

    const points = await Effect.runPromise(
      Effect.scoped(driver.pipe(Effect.provide(TestClock.layer())))
    )

    // The 5 text deltas, then the turn_complete (no token weight).
    const textPoints = points.filter((p) => p.value.type === "text_delta")
    expect(textPoints).toHaveLength(5)

    // First text delta arrives 100ms after the stream starts → TTFT = 100ms.
    expect(Duration.toMillis(textPoints[0]!.elapsed)).toBe(100)
    expect(textPoints[0]!.total).toBe(1)

    // Last text delta at 500ms; running rate = 5 tokens / 0.5s = 10 tok/s.
    expect(Duration.toMillis(textPoints[4]!.elapsed)).toBe(500)
    expect(textPoints[4]!.total).toBe(5)
    expect(textPoints[4]!.ratePerSecond).toBe(10)

    // turn_complete is the last event; total stays at 5 (no extra weight).
    const last = points[points.length - 1]!
    expect(last.value.type).toBe("turn_complete")
    expect(last.total).toBe(5)
  })

  it("metrics: timeToFirst on a paced stream", async () => {
    // Single text_delta after 250ms — Metrics.timeToFirst should report 250ms.
    const turn250: Turn = {
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }]
        }
      ],
      usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
      stop_reason: "stop"
    }

    const program = streamTurn([Items.userText("go")]).pipe(
      Metrics.timeToFirst((d: TurnDelta) => d.type === "text_delta"),
      Effect.provide(
        MockProvider.layer([turn250], { deltaInterval: "250 millis" })
      )
    )

    const driver = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(program)
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    })

    const result = await Effect.runPromise(
      Effect.scoped(driver.pipe(Effect.provide(TestClock.layer())))
    )

    expect(Option.isSome(result)).toBe(true)
    if (Option.isSome(result)) {
      expect(Duration.toMillis(result.value)).toBe(250)
    }
  })

  it("streamTurn yields delta-level events with turn_complete last", async () => {
    const program = Stream.runCollect(
      streamTurn([Items.userText("hi")])
    ).pipe(Effect.provide(MockProvider.layer([turn1])))

    const deltas: ReadonlyArray<TurnDelta> = await Effect.runPromise(program)

    expect(deltas.map((d) => d.type)).toEqual([
      "text_delta",
      "tool_call_start",
      "tool_call_args_delta",
      "turn_complete"
    ])
    const last = deltas[deltas.length - 1]!
    if (last.type === "turn_complete") {
      expect(last.turn.stop_reason).toBe("tool_calls")
    }
  })
})
