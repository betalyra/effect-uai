/**
 * Cover the two interesting behaviors:
 *
 *   1. `drainBurst` collects a burst of close-together messages into
 *      one batch and stops on the first quiet gap.
 *   2. `conversation` only checks the queue between cleanly-ended
 *      turns - tool-call turns flow straight into the next iteration.
 */
import { Effect, Fiber, Queue, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
import * as Turn from "@effect-uai/core/Turn"
import { conversation, drainBurst } from "./index.js"

// ---------------------------------------------------------------------------
// drainBurst
// ---------------------------------------------------------------------------

describe("drainBurst", () => {
  it("collects messages that arrive within the settle window", async () => {
    const program = Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()
      const collector = yield* Effect.forkChild(drainBurst(queue, "20 millis"))

      yield* Queue.offer(queue, "a")
      yield* Effect.sleep("5 millis")
      yield* Queue.offer(queue, "b")
      yield* Effect.sleep("5 millis")
      yield* Queue.offer(queue, "c")
      // Now go quiet - drainBurst should resolve after ~20ms.

      return yield* Fiber.join(collector)
    })

    const result = await Effect.runPromise(program)
    expect([...result]).toEqual(["a", "b", "c"])
  })

  it("blocks for the first message even with a tiny settle window", async () => {
    const program = Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()
      const collector = yield* Effect.forkChild(drainBurst(queue, "5 millis"))

      // Sleep for much longer than the settle window before offering
      // anything. drainBurst should still be parked on the first take.
      yield* Effect.sleep("50 millis")
      yield* Queue.offer(queue, "late")

      return yield* Fiber.join(collector)
    })

    const result = await Effect.runPromise(program)
    expect([...result]).toEqual(["late"])
  })

  it("ends on the first quiet gap longer than settle", async () => {
    const program = Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()
      const collector = yield* Effect.forkChild(drainBurst(queue, "10 millis"))

      yield* Queue.offer(queue, "first")
      yield* Effect.sleep("30 millis") // longer than settle - burst ends here
      yield* Queue.offer(queue, "second")

      const first = yield* Fiber.join(collector)

      // The second message stays on the queue for the next drain.
      const next = yield* Queue.take(queue)
      return { first: [...first], next }
    })

    const result = await Effect.runPromise(program)
    expect(result.first).toEqual(["first"])
    expect(result.next).toBe("second")
  })
})

// ---------------------------------------------------------------------------
// conversation
// ---------------------------------------------------------------------------

const GetTimeInput = Schema.Struct({ timezone: Schema.String })
const getTime = Tool.make({
  name: "get_time",
  description: "Get the current time for a timezone.",
  inputSchema: Tool.fromEffectSchema(GetTimeInput),
  run: ({ timezone }) => Effect.succeed({ timezone, iso: "2026-05-04T12:00:00Z" }),
  strict: true,
})

const fc = (call_id: string, args: unknown): Items.HistoryItem => ({
  type: "function_call",
  call_id,
  name: "get_time",
  arguments: JSON.stringify(args),
})

const assistantText = (text: string): Turn.Turn => ({
  stop_reason: "stop",
  usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
})

const toolCallTurn = (call_id: string, args: unknown): Turn.Turn => ({
  stop_reason: "tool_calls",
  usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  items: [fc(call_id, args)],
})

describe("conversation", () => {
  it("collects a burst into one user batch, runs tool, replies, then waits again", async () => {
    // Script:
    //   Turn 1 (after burst 1): tool_call get_time
    //   Turn 2 (with tool output, no queue check): final answer
    //   Turn 3 (after burst 2): final answer (no tools)
    const scriptedTurns = [
      toolCallTurn("c1", { timezone: "Europe/Lisbon" }),
      assistantText("It is noon in Lisbon."),
      assistantText("You're welcome."),
    ]
    const { layer, recorder } = MockProvider.layerWithRecorder(scriptedTurns)

    const program = Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(conversation(queue, [getTime], "20 millis")),
      )

      // Burst 1: three messages within the settle window.
      yield* Queue.offer(queue, "hi there")
      yield* Effect.sleep("5 millis")
      yield* Queue.offer(queue, "what time is it")
      yield* Effect.sleep("5 millis")
      yield* Queue.offer(queue, "in Lisbon please")

      // Wait long enough for: drain → turn 1 (tool_call) → tool exec → turn 2.
      yield* Effect.sleep("150 millis")

      // Burst 2: one message, then quiet.
      yield* Queue.offer(queue, "thanks")

      // Wait for: drain → turn 3.
      yield* Effect.sleep("100 millis")

      yield* Fiber.interrupt(fiber)
      return yield* recorder
    })

    const { calls } = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    // The mock should have been called exactly three times.
    expect(calls).toHaveLength(3)

    const userTextsIn = (history: ReadonlyArray<Items.HistoryItem>) =>
      history
        .filter((i): i is Items.Message => i.type === "message" && i.role === "user")
        .flatMap((m) => m.content)
        .filter(Items.isInputText)
        .map((c) => c.text)

    // Turn 1's history: all three messages from burst 1, no others.
    expect(userTextsIn(calls[0]!.history)).toEqual([
      "hi there",
      "what time is it",
      "in Lisbon please",
    ])

    // Turn 2's history: same three user messages (NOT re-checked the queue),
    // plus the assistant tool_call and the function_call_output.
    expect(userTextsIn(calls[1]!.history)).toEqual([
      "hi there",
      "what time is it",
      "in Lisbon please",
    ])
    expect(calls[1]!.history.some((i) => i.type === "function_call")).toBe(true)
    expect(calls[1]!.history.some((i) => i.type === "function_call_output")).toBe(true)

    // Turn 3's history: original 3 + the new "thanks" from burst 2.
    expect(userTextsIn(calls[2]!.history)).toEqual([
      "hi there",
      "what time is it",
      "in Lisbon please",
      "thanks",
    ])
  })
})
