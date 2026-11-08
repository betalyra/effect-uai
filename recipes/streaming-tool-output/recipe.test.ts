/**
 * Tests for both streaming tools: the sub-agent (answer so far) and the
 * download (progress snapshots). Both go through the same recipe shape,
 * only the tools differ.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { type State, buildConversation, makeDownloadTool, makeSubAgent } from "./recipe.js"

const fc = (call_id: string, name: string, args: unknown): Items.ToolCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const finalTurn: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 },
  items: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
  ],
}

const callTurn = (call: Items.ToolCall): Turn.Turn => ({
  stop_reason: "tool_calls",
  usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  items: [call],
})

const initial: State = { history: [Items.userText("go")], index: 0 }

describe("streaming-tool-output", () => {
  it.effect("sub-agent: partials grow with the inner text; the model gets the full answer", () =>
    Effect.gen(function* () {
      const inner = Stream.fromIterable<Turn.TurnEvent>([
        Turn.TurnEvent.TextDelta({ text: "Let me reason... " }),
        Turn.TurnEvent.TextDelta({ text: "42." }),
      ])
      const toolkit = Toolkit.make(makeSubAgent(() => inner))

      const events = yield* Stream.runCollect(buildConversation(toolkit, initial)).pipe(
        Effect.provide(
          MockProvider.layer([callTurn(fc("c1", "ask_subagent", { question: "?" })), finalTurn]),
        ),
      )

      const partials = events.flatMap((e) => (e._tag === "Partial" ? [e.value.answer] : []))
      expect(partials).toEqual(["", "Let me reason... ", "Let me reason... 42."])
      const [outcome] = events.filter(Toolkit.isOutcome)
      expect(outcome?.result).toEqual(Result.succeed({ answer: "Let me reason... 42." }))
    }),
  )

  it.effect("download: one snapshot per chunk, then the completed download", () =>
    Effect.gen(function* () {
      const toolkit = Toolkit.make(makeDownloadTool("0 millis"))

      const events = yield* Stream.runCollect(buildConversation(toolkit, initial)).pipe(
        Effect.provide(
          MockProvider.layer([
            callTurn(fc("c1", "download_artifact", { url: "example.com/file", chunks: 3 })),
            finalTurn,
          ]),
        ),
      )

      const progress = events.flatMap((e) => (e._tag === "Partial" ? [e.value.pct] : []))
      expect(progress).toEqual([33, 67, 100, 100])
      const [outcome] = events.filter(Toolkit.isOutcome)
      expect(outcome?.result).toEqual(
        Result.succeed({
          status: "completed",
          pct: 100,
          chunks: 3,
          bytes: "bytes-of-example.com/file",
        }),
      )
    }),
  )
})
