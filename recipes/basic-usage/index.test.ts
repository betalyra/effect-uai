import { Effect, Schema, Stream, pipe } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import { type ToolResult, toFunctionCallOutput } from "@effect-uai/core/Outcome"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
import { type ToolEvent, isOutput } from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

describe("basic-usage", () => {
  it("runs a turn, executes the requested tool, and stops on the final answer", async () => {
    // A trivial deterministic tool.
    const GreetInput = Schema.Struct({ name: Schema.String })
    const greet = Tool.make({
      name: "greet",
      description: "Say hello to a person.",
      inputSchema: Tool.fromEffectSchema(GreetInput),
      run: ({ name }) => Effect.succeed({ greeting: `Hello, ${name}!` }),
      strict: true,
    })
    const toolkit = Toolkit.make([greet])

    // Script the model: turn 1 calls the tool, turn 2 produces a final answer.
    const turn1: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      items: [
        {
          type: "function_call",
          call_id: "c1",
          name: "greet",
          arguments: '{"name":"World"}',
        },
      ],
    }
    const turn2: Turn.Turn = {
      stop_reason: "stop",
      usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Greeting sent." }],
        },
      ],
    }

    interface State {
      readonly history: ReadonlyArray<Items.Item>
      readonly index: number
    }

    const initial: State = {
      history: [Items.userText("greet World")],
      index: 0,
    }

    // Same shape as the recipe, against `LanguageModel` for testability.
    const conversation = pipe(
      initial,
      loop((state) =>
        Effect.gen(function* () {
          const lm = yield* LanguageModel
          return lm
            .streamTurn({
              history: state.history,
              model: "mock",
              tools: Toolkit.toDescriptors(toolkit),
            })
            .pipe(
              streamUntilComplete<State, ToolEvent>((turn) =>
                Effect.sync(() => {
                  const calls = Turn.functionCalls(turn)
                  if (calls.length === 0) return stop

                  const events = Toolkit.executeAll(toolkit.tools, calls)
                  return Toolkit.nextStateFrom(events, (results) =>
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

    const events = await Effect.runPromise(
      Stream.runCollect(conversation).pipe(Effect.provide(MockProvider.layer([turn1, turn2]))),
    )

    const turnCompletes = events.filter(
      (e): e is Extract<Turn.TurnEvent, { type: "turn_complete" }> =>
        "type" in e && e.type === "turn_complete",
    )
    const toolResults: ReadonlyArray<ToolResult> = events
      .filter((e): e is ToolEvent => "_tag" in e)
      .filter(isOutput)
      .map((e) => e.result)

    expect(turnCompletes).toHaveLength(2)
    expect(turnCompletes[0]!.turn.stop_reason).toBe("tool_calls")
    expect(turnCompletes[1]!.turn.stop_reason).toBe("stop")

    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toMatchObject({
      _tag: "Value",
      call_id: "c1",
      tool: "greet",
      value: { greeting: "Hello, World!" },
    })
  })
})
