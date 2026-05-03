/**
 * End-to-end test of the HITL example, mirroring
 * `recipes/tool-call-approval/index.test.ts` but using the spike
 * primitives. Confirms the same scenarios still pass with the new API.
 */
import { Effect, Fiber, Queue, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import type * as Turn from "@effect-uai/core/Turn"
import {
  type AwaitingApproval,
  type Verdict,
  buildConversation,
  reconcile,
} from "./hitl-example.js"
import { isReconciled } from "./history-check.js"
import { isCancelled, isDenied, parseFailure } from "./tool-outcome.js"

const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

describe("hitl-example (partition spike, end-to-end)", () => {
  const initial = {
    history: [Items.userText("...")] as ReadonlyArray<Items.Item>,
  }

  // --- Tests ---------------------------------------------------------------

  it("safe runs immediately, sensitive awaits and resolves, denial uses ToolFailure schema", async () => {
    const turn1: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: {},
      items: [
        fc("c-search", "search_emails", { query: "expense" }),
        fc("c-send", "send_email", {
          to: "alice@example.com",
          subject: "X",
          body: "Y",
        }),
      ],
    }
    const turn2: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: {},
      items: [fc("c-del", "delete_user", { user_id: "u-deprecated" })],
    }
    const turn3: Turn.Turn = {
      stop_reason: "stop",
      usage: {},
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
    }

    const verdictFor = (call: Items.FunctionCall): Verdict =>
      call.name === "delete_user"
        ? { call_id: call.call_id, decision: "deny", reason: "Out of scope." }
        : { call_id: call.call_id, decision: "approve" }

    const program = Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()
      const conversation = buildConversation(verdicts, initial)
      const tapped = conversation.pipe(
        Stream.tap((event) =>
          "type" in event && event.type === "awaiting_approval"
            ? Effect.forEach(event.calls, (c) => Queue.offer(verdicts, verdictFor(c)))
            : Effect.void,
        ),
      )
      return yield* Stream.runCollect(tapped)
    })

    const events = await Effect.runPromise(
      program.pipe(Effect.provide(MockProvider.layer([turn1, turn2, turn3]))),
    )

    const awaiting = events.filter(
      (e): e is AwaitingApproval => "type" in e && e.type === "awaiting_approval",
    )
    expect(awaiting).toHaveLength(2)

    const outputs = events.filter(
      (e): e is Items.FunctionCallOutput =>
        "type" in e && e.type === "function_call_output",
    )
    expect(outputs.map((o) => o.call_id)).toEqual(["c-search", "c-send", "c-del"])

    // Real success outputs parse as null (not failures).
    expect(parseFailure(outputs[0]!)).toBeNull()
    expect(parseFailure(outputs[1]!)).toBeNull()

    // Denial parses as a typed Denied failure.
    const denialFailure = parseFailure(outputs[2]!)
    expect(denialFailure).not.toBeNull()
    expect(isDenied(denialFailure!)).toBe(true)
    expect(denialFailure).toEqual({ kind: "denied", reason: "Out of scope." })
  })

  it("blocks the loop until verdict arrives for every sensitive call (no premature progress)", async () => {
    const turn1: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: {},
      items: [
        fc("a", "send_email", { to: "x@y.com", subject: "s", body: "b" }),
        fc("b", "send_email", { to: "p@q.com", subject: "s", body: "b" }),
      ],
    }
    const turn2: Turn.Turn = {
      stop_reason: "stop",
      usage: {},
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
    }

    const { layer, recorder } = MockProvider.layerWithRecorder([turn1, turn2])

    const program = Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()
      const conversation = buildConversation(verdicts, initial)
      const fiber = yield* Effect.forkChild(Stream.runDrain(conversation))

      yield* Effect.sleep("20 millis")
      expect((yield* recorder).calls).toHaveLength(1)

      yield* Queue.offer(verdicts, { call_id: "a", decision: "approve" })
      yield* Effect.sleep("20 millis")
      expect((yield* recorder).calls).toHaveLength(1)

      yield* Queue.offer(verdicts, { call_id: "b", decision: "approve" })
      yield* Fiber.join(fiber)
      expect((yield* recorder).calls).toHaveLength(2)
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })

  it("`reconcile` makes a history with orphan function_calls submittable", () => {
    // Simulates the "user sent a follow-up while approvals were pending"
    // case in a stateless HTTP server.
    const orphanedHistory: ReadonlyArray<Items.Item> = [
      Items.userText("delete user u-1"),
      fc("c1", "delete_user", { user_id: "u-1" }),
      fc("c2", "send_email", { to: "x", subject: "y", body: "z" }),
      // No outputs - user pivoted.
      Items.userText("actually never mind, what's the weather?"),
    ]
    expect(isReconciled(orphanedHistory)).toBe(false)

    const fixed = reconcile(orphanedHistory, "User pivoted before approving.")
    expect(isReconciled(fixed)).toBe(true)

    // The synthesized cancellations parse back through the typed schema.
    const cancellations = fixed.filter(
      (i): i is Items.FunctionCallOutput => i.type === "function_call_output",
    )
    expect(cancellations).toHaveLength(2)
    cancellations.forEach((out) => {
      const failure = parseFailure(out)
      expect(failure).not.toBeNull()
      expect(isCancelled(failure!)).toBe(true)
    })
  })
})
