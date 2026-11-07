import { describe, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import type { ApprovalMapEntry } from "@effect-uai/core/Approval"
import type * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import { isApprovalRequested, isOutput } from "@effect-uai/core/ToolEvent"
import type * as Turn from "@effect-uai/core/Turn"
import {
  type Verdict,
  fromQueue,
  httpConversation,
  isSensitive,
  queueConversation,
} from "./recipe.js"

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

const deleteCall = (call_id: string): Items.ToolCall => ({
  type: "function_call",
  call_id,
  name: "delete_user",
  arguments: '{"user_id":"u"}',
})

describe("tool-call-approval: queue variant", () => {
  it.effect("gates the sensitive calls on verdicts and still returns a result for a denial", () =>
    Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()
      // Collect in the background: the stream cannot finish until the verdicts arrive.
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(queueConversation(verdicts, undefined, "mock")),
      )
      yield* Queue.offerAll(verdicts, [
        { call_id: "send", decision: "approve" },
        { call_id: "del", decision: "deny", reason: "not allowed" },
      ])
      const events = yield* Fiber.join(fiber)

      const asked = events.filter(isApprovalRequested).map((e) => e.call_id)
      expect([...asked].sort()).toEqual(["del", "send"])

      const outputs = events.filter(isOutput).map((e) => e.result)
      expect(outputs.find((r) => r.call_id === "safe")?._tag).toBe("Ok")
      expect(outputs.find((r) => r.call_id === "send")?._tag).toBe("Ok")
      // A denial still returns a result to the model, so the turn stays valid.
      expect(outputs.find((r) => r.call_id === "del")?._tag).toBe("Failure")
    }).pipe(Effect.provide(scripted), Effect.scoped),
  )

  it.effect("the router retires per round, so sequential rounds over one queue both resolve", () =>
    Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()

      const r1 = yield* fromQueue(isSensitive, verdicts)([deleteCall("c1")])
      yield* Queue.offer(verdicts, { call_id: "c1", decision: "approve" })
      const d1 = yield* Stream.runCollect(r1.decisions)

      const r2 = yield* fromQueue(isSensitive, verdicts)([deleteCall("c2")])
      yield* Queue.offer(verdicts, { call_id: "c2", decision: "deny", reason: "no" })
      const d2 = yield* Stream.runCollect(r2.decisions)

      expect(d1[0]).toMatchObject({ _tag: "Approved" })
      expect(d2[0]).toMatchObject({ _tag: "Rejected", result: { kind: "denied", reason: "no" } })
    }).pipe(Effect.scoped),
  )

  it.effect("a timeout resolves an unanswered gated call as cancelled", () =>
    Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()
      const { decisions } = yield* fromQueue(isSensitive, verdicts, { timeout: "1 minute" })([
        deleteCall("c1"),
      ])
      const fiber = yield* Effect.forkChild(Stream.runCollect(decisions))
      yield* TestClock.adjust("1 minute")
      const [decision] = yield* Fiber.join(fiber)

      expect(decision).toMatchObject({ _tag: "Rejected", result: { kind: "cancelled" } })
    }).pipe(Effect.scoped),
  )
})

describe("tool-call-approval: http variant", () => {
  it.effect("turns a missing approval entry into a cancelled result rather than running it", () =>
    Effect.gen(function* () {
      const approvals = new Map<string, ApprovalMapEntry>([["send", { decision: "approve" }]])
      const events = yield* Stream.runCollect(httpConversation(approvals, undefined, "mock"))

      const outputs = events.filter(isOutput).map((e) => e.result)
      expect(outputs.find((r) => r.call_id === "send")?._tag).toBe("Ok")
      // `delete_user` was sensitive and unmentioned by the request payload.
      expect(outputs.find((r) => r.call_id === "del")).toMatchObject({ kind: "cancelled" })
    }).pipe(Effect.provide(scripted), Effect.scoped),
  )
})
