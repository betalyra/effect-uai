import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import * as Items from "../domain/Items.js"
import * as Approval from "./Approval.js"
import * as HistoryCheck from "./HistoryCheck.js"
import * as Tool from "./Tool.js"
import * as Toolkit from "./Toolkit.js"
import * as ToolOutput from "./ToolOutput.js"

const call = (id: string): Items.ToolCall => ({
  type: "function_call",
  call_id: id,
  name: "send_email",
  arguments: "{}",
})

const Decisions = Approval.decisions({
  Approve: { always: Schema.optionalKey(Schema.Boolean) },
  Deny: { reason: Schema.optionalKey(Schema.String) },
  Respond: { output: Schema.Json },
})

describe("Approval.decisions", () => {
  it("groups waiting calls by answer, ignores answers to other calls, keeps the rest unanswered", () => {
    const waiting = [call("a"), call("b"), call("c"), call("d")]
    const resolved = Decisions.resolve(waiting, [
      { callId: "a", decision: Decisions.Approve({ always: true }) },
      { callId: "b", decision: Decisions.Deny({ reason: "spam" }) },
      { callId: "c", decision: Decisions.Respond({ output: { booked: true } }) },
      { callId: "closed-long-ago", decision: Decisions.Approve() },
    ])
    expect(resolved).toEqual({
      Approve: [{ call: call("a"), decision: { _tag: "Approve", always: true } }],
      Deny: [{ call: call("b"), decision: { _tag: "Deny", reason: "spam" } }],
      Respond: [{ call: call("c"), decision: { _tag: "Respond", output: { booked: true } } }],
      unanswered: [call("d")],
    })
    expectTypeOf(resolved.Deny[0]!.decision).toEqualTypeOf<{
      readonly _tag: "Deny"
      readonly reason?: string
    }>()
  })

  it.effect("decodes answers from the wire and rejects unknown tags", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Decisions.schema)
      expect(yield* decode({ _tag: "Deny", reason: "no" })).toEqual(
        Decisions.Deny({ reason: "no" }),
      )
      const error = yield* Effect.flip(decode({ _tag: "Maybe" }))
      expect(error._tag).toBe("SchemaError")
    }),
  )

  it("type: constructors need their required fields", () => {
    Decisions.Approve()
    // @ts-expect-error Respond requires `output`
    Decisions.Respond()
  })
})

describe("closing waiting calls", () => {
  const Sent = Schema.Struct({ id: Schema.String })
  const sendEmail = Tool.make({
    name: "send_email",
    description: "",
    inputSchema: Tool.noInput,
    outputSchema: Sent,
    run: () => Effect.succeed({ id: "m1" }),
  })
  const kit = Toolkit.make(sendEmail)

  it.effect("a user-supplied result reads back like the tool's own output", () =>
    Effect.gen(function* () {
      const answered = yield* ToolOutput.success(call("b"), Sent, { id: "u1" })
      expect(yield* Toolkit.decode(kit, "send_email", answered)).toEqual(
        Result.succeed({ id: "u1" }),
      )
    }),
  )

  it.effect("a denied call carries the tagged error the model sees", () =>
    Effect.gen(function* () {
      const denied = new Approval.Denied({ message: "spam" })
      expect(yield* ToolOutput.failure(call("a"), Approval.Denied, denied)).toEqual({
        type: "function_call_output",
        call_id: "a",
        output: [{ type: "input_json", value: { _tag: "Denied", message: "spam" } }],
        isError: true,
      })
    }),
  )
})

describe("HistoryCheck", () => {
  it.effect("closes every unanswered call with Cancelled, so history is submittable", () =>
    Effect.gen(function* () {
      const history: ReadonlyArray<Items.HistoryItem> = [
        Items.userText("send both"),
        call("a"),
        call("b"),
        Items.toolCallOutput("a", "sent"),
      ]
      expect(HistoryCheck.findUnansweredCalls(history)).toEqual([call("b")])

      const closing = yield* HistoryCheck.cancelAllPending(history, "user moved on")
      expect(closing).toEqual([
        {
          type: "function_call_output",
          call_id: "b",
          output: [{ type: "input_json", value: { _tag: "Cancelled", message: "user moved on" } }],
          isError: true,
        },
      ])
      expect(HistoryCheck.isReconciled([...history, ...closing])).toBe(true)
    }),
  )
})
