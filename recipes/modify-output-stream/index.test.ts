/**
 * Run the conversation against a mocked provider, format the resulting
 * stream, and assert the wire output is what we'd send.
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import { conversation, toJSONL, toSSE } from "./index.js"

const finalTurn: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Lisbon has good light and tiles." }],
    },
  ],
}

describe("modify-output-stream", () => {
  it("formats the loop's output as Server-Sent Events", async () => {
    const sse = conversation.pipe(Stream.filterMap(toSSE))

    const events = await Effect.runPromise(
      Stream.runCollect(sse).pipe(Effect.provide(MockProvider.layer([finalTurn]))),
    )

    expect(events.map((e) => e.event)).toEqual(["text", "done"])
    expect(JSON.parse(events[0]!.data)).toEqual({ text: "Lisbon has good light and tiles." })
    expect(JSON.parse(events[1]!.data)).toMatchObject({
      stop_reason: "stop",
      text: "Lisbon has good light and tiles.",
    })
  })

  it("formats the loop's output as JSONL lines", async () => {
    const jsonl = conversation.pipe(Stream.filterMap(toJSONL))

    const lines = await Effect.runPromise(
      Stream.runCollect(jsonl).pipe(Effect.provide(MockProvider.layer([finalTurn]))),
    )

    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0]).toEqual({ type: "text", text: "Lisbon has good light and tiles." })
    expect(parsed[1]).toMatchObject({ type: "done", stop_reason: "stop" })
  })
})
