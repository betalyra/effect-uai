import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import type * as Turn from "@effect-uai/core/Turn"
import { conversation } from "./recipe.js"

const answering = (text: string): Turn.Turn => ({
  stop_reason: "stop",
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
})

/** A compaction call is the one whose last message asks for the summary. */
const isCompaction = (history: ReadonlyArray<Items.HistoryItem>): boolean => {
  const last = history[history.length - 1]
  return (
    last?.type === "message" &&
    last.role === "user" &&
    last.content.some(
      (b) => b.type === "input_text" && b.text.startsWith("Summarize the conversation above"),
    )
  )
}

const firstUserText = (history: ReadonlyArray<Items.HistoryItem>): string | undefined => {
  const first = history[0]
  if (first?.type !== "message") return undefined
  const block = first.content.find((b) => b.type === "input_text")
  return block?.type === "input_text" ? block.text : undefined
}

describe("auto-compaction", () => {
  // Five prompts at MAX_TURNS = 2 means the loop compacts twice: after the
  // second and fourth normal turns. Seven provider calls in all.
  it("compacts on the turn budget and replays the summary as the new head", async () => {
    const { layer, recorder } = MockProvider.layerWithRecorder(
      Array.from({ length: 7 }, (_, i) => answering(`answer-${i}`)),
    )

    const { calls } = await Effect.runPromise(
      Effect.flatMap(Stream.runDrain(conversation("mock", "mock")), () => recorder).pipe(
        Effect.provide(layer),
      ),
    )

    expect(calls).toHaveLength(7)

    const compactions = calls.filter((c) => isCompaction(c.history))
    expect(compactions).toHaveLength(2)

    // Every call right after a compaction starts from the summary, not from
    // the history it replaced. That swap is the whole point of the recipe.
    const afterCompaction = calls.filter(
      (_, i) => i > 0 && isCompaction(calls[i - 1]!.history) && !isCompaction(calls[i]!.history),
    )
    expect(afterCompaction).toHaveLength(2)
    for (const call of afterCompaction) {
      expect(firstUserText(call.history)).toMatch(/^\[Summary of earlier conversation\]:/)
    }
  })
})
