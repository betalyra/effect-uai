import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Approval from "@effect-uai/core/Approval"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Toolkit from "@effect-uai/core/Toolkit"
import type * as Turn from "@effect-uai/core/Turn"
import {
  type Answer,
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

const deleteCall = (call_id: string): Items.ToolCall => ({
  type: "function_call",
  call_id,
  name: "delete_user",
  arguments: '{"user_id":"u"}',
})

// The history the model sees on its second turn: what each call closed with.
const secondRequestOutputs = (
  requests: ReadonlyArray<{ readonly history: ReadonlyArray<Items.HistoryItem> }>,
) =>
  Object.fromEntries(
    (requests[1]?.history ?? [])
      .filter(Items.isToolCallOutput)
      .map((o) => [o.call_id, { isError: o.isError === true, output: o.output }]),
  )

describe("tool-call-approval: queue variant", () => {
  it.effect("gates the sensitive calls on answers; a denial still reaches the model", () =>
    Effect.gen(function* () {
      const { layer, recorder } = MockProvider.layerWithRecorder([askingForAll, done])
      const answers = yield* Queue.unbounded<Answer>()
      // Collect in the background: the stream cannot finish until the answers arrive.
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(queueConversation(answers, undefined, "mock")).pipe(
          Effect.provide(layer),
        ),
      )
      yield* Queue.offerAll(answers, [
        { callId: "send", decision: Approval.Default.Approve() },
        { callId: "del", decision: Approval.Default.Deny({ reason: "not allowed" }) },
      ])
      const events = yield* Fiber.join(fiber)

      const asked = events.flatMap((e) => (e._tag === "ApprovalRequested" ? [e.call.call_id] : []))
      expect([...asked].sort()).toEqual(["del", "send"])

      const outputs = secondRequestOutputs((yield* recorder).calls)
      expect(outputs["safe"]?.isError).toBe(false)
      expect(outputs["send"]?.isError).toBe(false)
      expect(outputs["del"]).toEqual({
        isError: true,
        output: [{ type: "input_json", value: { _tag: "Denied", message: "not allowed" } }],
      })
    }).pipe(Effect.scoped),
  )

  it.effect("the router retires per round, so sequential rounds over one queue both settle", () =>
    Effect.gen(function* () {
      const answers = yield* Queue.unbounded<Answer>()
      const outcomesOf = <E>(stream: Stream.Stream<{ readonly _tag: string }, E>) =>
        Stream.runCollect(stream.pipe(Stream.filter(Toolkit.isOutcome)))

      const r1 = yield* fromQueue(isSensitive, answers)([deleteCall("c1")])
      yield* Queue.offer(answers, { callId: "c1", decision: Approval.Default.Approve() })
      const [o1] = yield* outcomesOf(r1)

      const r2 = yield* fromQueue(isSensitive, answers)([deleteCall("c2")])
      yield* Queue.offer(answers, { callId: "c2", decision: Approval.Default.Deny() })
      const [o2] = yield* outcomesOf(r2)

      expect(o1).toMatchObject({ call_id: "c1", result: { _tag: "Success" } })
      expect(o2).toMatchObject({
        call_id: "c2",
        result: { _tag: "Failure", failure: { _tag: "Denied" } },
      })
    }).pipe(Effect.scoped),
  )

  it.effect("a timeout closes an unanswered gated call as cancelled", () =>
    Effect.gen(function* () {
      const answers = yield* Queue.unbounded<Answer>()
      const events = yield* fromQueue(isSensitive, answers, { timeout: "1 minute" })([
        deleteCall("c1"),
      ])
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(Stream.filter(events, Toolkit.isOutcome)),
      )
      yield* TestClock.adjust("1 minute")
      const [outcome] = yield* Fiber.join(fiber)

      expect(outcome).toMatchObject({ result: { _tag: "Failure", failure: { _tag: "Cancelled" } } })
    }).pipe(Effect.scoped),
  )
})

describe("tool-call-approval: http variant", () => {
  it.effect("closes an unanswered sensitive call as cancelled instead of running it", () =>
    Effect.gen(function* () {
      const { layer, recorder } = MockProvider.layerWithRecorder([askingForAll, done])
      yield* Stream.runCollect(
        httpConversation(
          [{ callId: "send", decision: Approval.Default.Approve() }],
          undefined,
          "mock",
        ),
      ).pipe(Effect.provide(layer))

      const outputs = secondRequestOutputs((yield* recorder).calls)
      expect(outputs["send"]?.isError).toBe(false)
      // `delete_user` was sensitive and the request carried no answer for it.
      expect(outputs["del"]).toEqual({
        isError: true,
        output: [
          { type: "input_json", value: { _tag: "Cancelled", message: "No approval was given." } },
        ],
      })
    }).pipe(Effect.scoped),
  )
})
