import { Effect, Fiber, Queue, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type { ApprovalMapEntry, Verdict } from "@effect-uai/core/Approval"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import { isApprovalRequested, isOutput } from "@effect-uai/core/ToolEvent"
import type * as Turn from "@effect-uai/core/Turn"
import { httpConversation, queueConversation } from "./recipe.js"

/** One turn asking for the safe tool and both sensitive ones. */
const askingForAll: Turn.Turn = {
  stop_reason: "tool_calls",
  usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  items: [
    { type: "function_call", call_id: "safe", name: "search_emails", arguments: '{"query":"x"}' },
    {
      type: "function_call",
      call_id: "send",
      name: "send_email",
      arguments: '{"to":"a@b.c","subject":"s","body":"b"}',
    },
    { type: "function_call", call_id: "del", name: "delete_user", arguments: '{"user_id":"u"}' },
  ],
}

const done: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
}

const scripted = MockProvider.layer([askingForAll, done])

describe("tool-call-approval: queue variant", () => {
  it("gates the sensitive calls on verdicts and still returns a result for a denial", async () => {
    const program = Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()

      // Collect in the background: the stream cannot finish until the
      // verdicts below arrive, so joining first would deadlock.
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(queueConversation(verdicts, undefined, "mock")),
      )

      yield* Queue.offerAll(verdicts, [
        { call_id: "send", decision: "approve" },
        { call_id: "del", decision: "deny", reason: "not allowed" },
      ])

      return yield* Fiber.join(fiber)
    })

    const events = await Effect.runPromise(program.pipe(Effect.provide(scripted), Effect.scoped))

    // Only the sensitive calls are announced for approval.
    const asked = events.filter(isApprovalRequested).map((e) => e.call_id)
    expect([...asked].sort()).toEqual(["del", "send"])

    const outputs = events.filter(isOutput).map((e) => e.result)
    expect(outputs.find((r) => r.call_id === "safe")?._tag).toBe("Ok")
    expect(outputs.find((r) => r.call_id === "send")?._tag).toBe("Ok")

    // A denial still returns a result to the model, so the turn stays valid.
    expect(outputs.find((r) => r.call_id === "del")?._tag).toBe("Failure")
  })
})

describe("tool-call-approval: http variant", () => {
  it("turns a missing approval entry into a cancelled result rather than running it", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([["send", { decision: "approve" }]])

    const events = await Effect.runPromise(
      Stream.runCollect(httpConversation(approvals, undefined, "mock")).pipe(
        Effect.provide(scripted),
        Effect.scoped,
      ),
    )

    const outputs = events.filter(isOutput).map((e) => e.result)
    expect(outputs.find((r) => r.call_id === "send")?._tag).toBe("Ok")

    // `delete_user` was sensitive and unmentioned by the request payload.
    const missing = outputs.find((r) => r.call_id === "del")
    expect(missing?._tag).toBe("Failure")
    if (missing?._tag === "Failure") expect(missing.kind).toBe("cancelled")
  })
})
