import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Stream } from "effect"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { makeConversation } from "./recipe.js"

describe("basic-usage", () => {
  it.effect("runs a turn, executes get_current_time, and stops on the final answer", () =>
    Effect.gen(function* () {
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
      const events = yield* Stream.runCollect(makeConversation("mock")).pipe(
        Effect.provide(MockProvider.layer([turn1, turn2])),
      )

      const turnCompletes = events.filter(Turn.isTurnComplete)
      expect(turnCompletes.map((e) => e.turn.stop_reason)).toEqual(["tool_calls", "stop"])

      const outcomes = events.filter(Toolkit.isOutcome)
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({ call_id: "c1", tool: "get_current_time" })
      const result = outcomes[0]!.result
      expect(Result.isSuccess(result) && result.success.timezone).toBe("Europe/Lisbon")
    }),
  )
})
