import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import { isOutput } from "@effect-uai/core/ToolEvent"
import type { ToolResult } from "@effect-uai/core/ToolResult"
import * as Turn from "@effect-uai/core/Turn"
import { makeConversation } from "./recipe.js"

describe("basic-usage", () => {
  it("runs a turn, executes get_current_time, and stops on the final answer", async () => {
    // Script the model: turn 1 calls the recipe's tool, turn 2 answers.
    const turn1: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      items: [
        {
          type: "function_call",
          call_id: "c1",
          name: "get_current_time",
          arguments: '{"timezone":"Europe/Lisbon"}',
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
          content: [{ type: "output_text", text: "It's currently that time in Lisbon." }],
        },
      ],
    }

    // Drive the real recipe (`makeConversation`) against a scripted provider.
    const events = await Effect.runPromise(
      Stream.runCollect(makeConversation("mock")).pipe(
        Effect.provide(MockProvider.layer([turn1, turn2])),
      ),
    )

    const turnCompletes = events.filter(Turn.isTurnComplete)
    const toolResults: ReadonlyArray<ToolResult> = events.filter(isOutput).map((e) => e.result)

    expect(turnCompletes).toHaveLength(2)
    expect(turnCompletes[0]!.turn.stop_reason).toBe("tool_calls")
    expect(turnCompletes[1]!.turn.stop_reason).toBe("stop")

    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toMatchObject({
      _tag: "Ok",
      call_id: "c1",
      tool: "get_current_time",
      value: { timezone: "Europe/Lisbon" },
    })
  })
})
