import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Effect, Match, Result, Schema } from "effect"
import * as Items from "../domain/Items.js"
import * as ToolDecision from "./ToolDecision.js"
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

const Decisions = ToolDecision.make({
  Approve: { always: Schema.optionalKey(Schema.Boolean) },
  Deny: { reason: Schema.optionalKey(Schema.String) },
  Respond: { output: Schema.Json },
})

describe("ToolDecision.make", () => {
  it("groups waiting calls by answer, ignores answers to other calls, keeps the rest unanswered", () => {
    const waiting = [call("a"), call("b"), call("c"), call("d"), call("e")]
    const resolved = Decisions.resolve(waiting, [
      { callId: "a", decision: Decisions.Approve({ always: true }) },
      { callId: "b", decision: Decisions.Deny({ reason: "spam" }) },
      { callId: "c", decision: Decisions.Respond({ output: { booked: true } }) },
      { callId: "e", decision: { _tag: "Edit", subject: "hi" } },
      { callId: "closed-long-ago", decision: Decisions.Approve() },
    ])
    const approve = {
      _tag: "Approve",
      call: call("a"),
      decision: { _tag: "Approve", always: true },
    }
    const deny = { _tag: "Deny", call: call("b"), decision: { _tag: "Deny", reason: "spam" } }
    const respond = {
      _tag: "Respond",
      call: call("c"),
      decision: { _tag: "Respond", output: { booked: true } },
    }
    expect(resolved).toEqual({
      Approve: [approve],
      Deny: [deny],
      Respond: [respond],
      answered: [approve, deny, respond],
      unanswered: [call("d")],
      // An answer this definition doesn't accept is reported, not dropped.
      invalid: [{ call: call("e"), decision: { _tag: "Edit", subject: "hi" } }],
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

  it("a closing decision comes with the error it names, built from its fields", () => {
    const { Deny } = ToolDecision.Default.resolve(
      [call("a"), call("b")],
      [
        { callId: "a", decision: ToolDecision.Default.Deny({ reason: "not today" }) },
        { callId: "b", decision: ToolDecision.Default.Deny() },
      ],
    )
    expect(Deny.map((d) => d.error)).toEqual([
      new ToolDecision.Denied({ message: "not today" }),
      new ToolDecision.Denied({ message: "The user declined." }),
    ])
    expectTypeOf(Deny[0]!.error).toEqualTypeOf<ToolDecision.Denied>()
  })

  it("answered lists every answered call, tagged by its decision, for an exhaustive Match", () => {
    const { answered } = ToolDecision.Default.resolve(
      [call("a"), call("b")],
      [
        { callId: "a", decision: ToolDecision.Default.Approve() },
        { callId: "b", decision: ToolDecision.Default.Deny({ reason: "no" }) },
      ],
    )
    const handled = answered.map(
      Match.type<(typeof answered)[number]>().pipe(
        Match.tagsExhaustive({
          Approve: ({ call }) => `run ${call.call_id}`,
          Deny: ({ call, error }) => `close ${call.call_id}: ${error.message}`,
        }),
      ),
    )
    expect(handled).toEqual(["run a", "close b: no"])
  })

  it("type: Match over answered must handle every decision", () => {
    const { answered } = ToolDecision.Default.resolve([], [])
    answered.map(
      Match.type<(typeof answered)[number]>().pipe(
        // @ts-expect-error Deny is not handled
        Match.tagsExhaustive({ Approve: () => "run" }),
      ),
    )
  })

  it("a call answered twice: the same answer counts once, two different ones are invalid", () => {
    const resolved = ToolDecision.Default.resolve(
      [call("a"), call("b")],
      [
        { callId: "a", decision: ToolDecision.Default.Approve() },
        { callId: "a", decision: ToolDecision.Default.Approve() },
        { callId: "b", decision: ToolDecision.Default.Approve() },
        { callId: "b", decision: ToolDecision.Default.Deny() },
      ],
    )
    expect(resolved.answered.map((e) => e.call.call_id)).toEqual(["a"])
    expect(resolved.invalid).toEqual([
      { call: call("b"), decision: [{ _tag: "Approve" }, { _tag: "Deny" }] },
    ])
  })
})

describe("ToolDecision.byTool", () => {
  class Escalated extends Schema.TaggedError<Escalated>()("Escalated", {
    team: Schema.Literals(["finance", "legal"]),
  }) {}

  const Refund = ToolDecision.make({
    Approve: {},
    Reduce: { amount: Schema.Number },
    Escalate: ToolDecision.closesWith(
      { team: Schema.Literals(["finance", "legal"]) },
      ({ team }) => new Escalated({ team }),
    ),
  })
  const Email = ToolDecision.make({
    Approve: {},
    Edit: { subject: Schema.String },
    // A closing decision is reusable across sets.
    Deny: ToolDecision.Default.variants.Deny,
  })
  const Decisions = ToolDecision.byTool(
    { issue_refund: Refund, send_email: Email },
    { fallback: ToolDecision.Default },
  )

  const named = (name: string, id: string): Items.ToolCall => ({
    type: "function_call",
    call_id: id,
    name,
    arguments: "{}",
  })

  it("resolves each call with its own tool's decisions, the rest with the fallback", () => {
    const waiting = [
      named("issue_refund", "r1"),
      named("issue_refund", "r2"),
      named("send_email", "e1"),
      named("helpdesk__write_ticket", "h1"),
      named("send_email", "e2"),
    ]
    const resolved = Decisions.resolve(waiting, [
      { callId: "r1", decision: Refund.Reduce({ amount: 40 }) },
      { callId: "r2", decision: Email.Edit({ subject: "a refund edited like an email" }) },
      { callId: "e1", decision: Email.Edit({ subject: "Your refund" }) },
      { callId: "h1", decision: ToolDecision.Default.Deny({ reason: "read only today" }) },
    ])
    expect(resolved.issue_refund.Reduce.map((r) => r.decision.amount)).toEqual([40])
    expect(resolved.send_email.Edit.map((r) => r.call.call_id)).toEqual(["e1"])
    expect(resolved.fallback.Deny.map((r) => r.error)).toEqual([
      new ToolDecision.Denied({ message: "read only today" }),
    ])
    expect(resolved.invalid.map((i) => i.call.call_id)).toEqual(["r2"])
    expect(resolved.unanswered.map((c) => c.call_id)).toEqual(["e2"])
  })

  it("without a fallback, a call nobody takes decisions for can't be answered", () => {
    const only = ToolDecision.byTool({ issue_refund: Refund })
    const resolved = only.resolve(
      [named("delete_ticket", "d1"), named("delete_ticket", "d2")],
      [{ callId: "d1", decision: ToolDecision.Default.Approve() }],
    )
    expect(resolved.invalid.map((i) => i.call.call_id)).toEqual(["d1"])
    expect(resolved.unanswered.map((c) => c.call_id)).toEqual(["d2"])
  })

  it.effect("decodes any set's answer from the wire", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Decisions.schema)
      expect(yield* decode({ _tag: "Reduce", amount: 5 })).toEqual(Refund.Reduce({ amount: 5 }))
      expect(yield* decode({ _tag: "Edit", subject: "s" })).toEqual(Email.Edit({ subject: "s" }))
    }),
  )

  it("type: two sets may share a tag only with the same fields", () => {
    const Always = ToolDecision.make({ Approve: { always: Schema.Boolean } })
    // @ts-expect-error "Approve" has different fields in issue_refund and send_email
    ToolDecision.byTool({ issue_refund: Refund, send_email: Always })
    // An optional extra field is a conflict too: the union would drop it.
    const Maybe = ToolDecision.make({ Approve: { always: Schema.optionalKey(Schema.Boolean) } })
    // @ts-expect-error "Approve" has different fields
    ToolDecision.byTool({ issue_refund: Refund }, { fallback: Maybe })
    // Same fields (or a reused variant) are fine.
    ToolDecision.byTool(
      { issue_refund: Refund, send_email: Email },
      { fallback: ToolDecision.Default },
    )
  })

  it("type: an answer takes its tool's decisions; groups and errors are typed per tool", () => {
    const refund = { callId: "r1", name: "issue_refund" } as const
    Decisions.answer(refund, Refund.Reduce({ amount: 1 }))
    // @ts-expect-error an email decision for a refund call
    Decisions.answer(refund, Email.Edit({ subject: "s" }))
    Decisions.answer(
      { callId: "h1", name: "helpdesk__write_ticket" },
      ToolDecision.Default.Approve(),
    )

    type Resolved = ToolDecision.ResolvedByTool<typeof Decisions.tools, typeof ToolDecision.Default>
    expectTypeOf<Resolved["issue_refund"]["Escalate"][number]["error"]>().toEqualTypeOf<Escalated>()
    expectTypeOf<
      Resolved["send_email"]["Edit"][number]["decision"]["subject"]
    >().toEqualTypeOf<string>()
    expectTypeOf<
      Resolved["send_email"]["Deny"][number]["error"]
    >().toEqualTypeOf<ToolDecision.Denied>()
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
      const denied = new ToolDecision.Denied({ message: "spam" })
      expect(yield* ToolOutput.failure(call("a"), ToolDecision.Denied, denied)).toEqual({
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
