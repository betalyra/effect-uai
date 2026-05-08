/**
 * Tests for approval planners + history-reconciliation primitives. Exercises
 * the full HITL + streaming-tool stack end-to-end by composing approval plans
 * with `executeAll`, with the four wire-shaped scenarios:
 *
 *   1. Approval        : gated calls approved → tools execute, structured Values
 *   2. Denial          : gated calls denied   → Failure(denied) results
 *   3. Cancellation    : missing verdicts     → Failure(cancelled) results
 *   4. Mixed + history : reconciliation via cancelAllPending
 *
 * Plus: hallucinated tool name (graceful Failure), unknown_tool kind.
 */
import { Effect, Queue, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "../domain/Items.js"
import { findUnansweredCalls, cancelAllPending, isReconciled } from "./HistoryCheck.js"
import { type ToolResult, isFailure, isValue, toFunctionCallOutput } from "./Outcome.js"
import {
  type ApprovalMapEntry,
  type ToolCallDecision,
  fromApprovalMap,
  fromVerdictQueue,
} from "./Resolvers.js"
import { fromEffectSchema, make as makeTool, streaming } from "./Tool.js"
import { executeAll, outputEvent, outputEvents } from "./Toolkit.js"
import { type ToolEvent, isApprovalRequested, isIntermediate, isOutput } from "./ToolEvent.js"

// ---------------------------------------------------------------------------
// Three demo tools covering the matrix:
//   - web_search      : streaming, no approval
//   - bulk_email      : streaming, requires approval
//   - delete_database : non-streaming, requires approval
// ---------------------------------------------------------------------------

const webSearch = streaming({
  name: "web_search",
  description: "search",
  inputSchema: fromEffectSchema(Schema.Struct({ query: Schema.String })),
  run: ({ query }) =>
    Stream.fromIterable([
      { url: "a", title: `${query} 1` },
      { url: "b", title: `${query} 2` },
      { url: "c", title: `${query} 3` },
    ]),
  finalize: (hits) => ({ count: hits.length }),
})

const bulkEmail = streaming({
  name: "bulk_email",
  description: "send",
  inputSchema: fromEffectSchema(
    Schema.Struct({ recipients: Schema.Array(Schema.String), subject: Schema.String }),
  ),
  run: ({ recipients }) =>
    Stream.fromIterable(
      recipients.map((_, i) => ({
        type: "progress" as const,
        sent: i + 1,
        total: recipients.length,
      })),
    ),
  finalize: (events) => ({ status: "sent" as const, delivered: events.length }),
})

const deleteDatabase = makeTool({
  name: "delete_database",
  description: "drop",
  inputSchema: fromEffectSchema(Schema.Struct({ name: Schema.String })),
  run: ({ name }) => Effect.succeed({ status: "dropped", name }),
})

const allTools = [webSearch, bulkEmail, deleteDatabase]
const SENSITIVE = new Set(["bulk_email", "delete_database"])
const isSensitive = (call: Items.FunctionCall) => SENSITIVE.has(call.name)

const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const calls = [
  fc("c1", "web_search", { query: "effect" }),
  fc("c2", "bulk_email", { recipients: ["a@x", "b@x"], subject: "Hi" }),
  fc("c3", "delete_database", { name: "prod" }),
]

const resultsFrom = (collected: ReadonlyArray<ToolEvent>): ReadonlyArray<ToolResult> =>
  collected.filter(isOutput).map((e) => e.result)

const byCallId = (results: ReadonlyArray<ToolResult>) => new Map(results.map((r) => [r.call_id, r]))

const eventsFromApprovalMap = (approvals: ReadonlyMap<string, ApprovalMapEntry>) => {
  const plan = fromApprovalMap(isSensitive, approvals)(calls)
  return Stream.merge(executeAll(allTools, plan.approved), outputEvents(plan.rejected))
}

const eventsFromDecision = (decision: ToolCallDecision): Stream.Stream<ToolEvent> =>
  decision._tag === "Approved"
    ? executeAll(allTools, [decision.call])
    : Stream.succeed(outputEvent(decision.result))

// ---------------------------------------------------------------------------
// fromApprovalMap: HTTP-style scenarios
// ---------------------------------------------------------------------------

describe("fromApprovalMap + executeAll", () => {
  it("approval: all gated approved → tools execute, structured Values", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "approve" }],
      ["c3", { decision: "approve" }],
    ])
    const collected = await Effect.runPromise(Stream.runCollect(eventsFromApprovalMap(approvals)))
    const by = byCallId(resultsFrom(collected))
    expect(by.get("c1")).toMatchObject({ _tag: "Value", value: { count: 3 } })
    expect(by.get("c2")).toMatchObject({
      _tag: "Value",
      value: { status: "sent", delivered: 2 },
    })
    expect(by.get("c3")).toMatchObject({
      _tag: "Value",
      value: { status: "dropped", name: "prod" },
    })

    // No ApprovalRequested events from the pure HTTP flow.
    expect(collected.filter(isApprovalRequested)).toHaveLength(0)
  })

  it("denial: gated denied → Failure(denied), no execution", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "deny", reason: "spam concern" }],
      ["c3", { decision: "deny", reason: "prod is sacred" }],
    ])
    const collected = await Effect.runPromise(Stream.runCollect(eventsFromApprovalMap(approvals)))

    // bulk_email never ran.
    expect(collected.filter(isIntermediate).filter((e) => e.tool === "bulk_email")).toHaveLength(0)

    const by = byCallId(resultsFrom(collected))
    expect(by.get("c2")).toMatchObject({
      _tag: "Failure",
      kind: "denied",
      reason: "spam concern",
    })
    expect(by.get("c3")).toMatchObject({
      _tag: "Failure",
      kind: "denied",
      reason: "prod is sacred",
    })
  })

  it("cancellation: missing verdicts → Failure(cancelled)", async () => {
    const collected = await Effect.runPromise(Stream.runCollect(eventsFromApprovalMap(new Map())))
    const by = byCallId(resultsFrom(collected))
    expect(by.get("c1")).toMatchObject({ _tag: "Value", value: { count: 3 } })
    expect(by.get("c2")).toMatchObject({ _tag: "Failure", kind: "cancelled" })
    expect(by.get("c3")).toMatchObject({ _tag: "Failure", kind: "cancelled" })
  })

  it("mixed: approve + deny + omit → all three kinds", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "approve" }],
      // c3 omitted → cancelled
    ])
    const collected = await Effect.runPromise(Stream.runCollect(eventsFromApprovalMap(approvals)))
    const by = byCallId(resultsFrom(collected))
    expect(by.get("c1")).toMatchObject({ _tag: "Value", value: { count: 3 } })
    expect(by.get("c2")).toMatchObject({ _tag: "Value", value: { status: "sent" } })
    expect(by.get("c3")).toMatchObject({ _tag: "Failure", kind: "cancelled" })
  })
})

// ---------------------------------------------------------------------------
// Graceful degradation: hallucinated tool name doesn't kill the turn.
// ---------------------------------------------------------------------------

describe("executeAll: graceful degradation", () => {
  it("unknown tool name → Failure(unknown_tool); other calls still execute", async () => {
    const callsWithBogus = [
      fc("c1", "web_search", { query: "x" }),
      fc("c2", "does_not_exist", {}),
      fc("c3", "delete_database", { name: "prod" }),
    ]
    const collected = await Effect.runPromise(
      Stream.runCollect(
        (() => {
          const plan = fromApprovalMap(
            isSensitive,
            new Map([["c3", { decision: "approve" }]]),
          )(callsWithBogus)
          return Stream.merge(executeAll(allTools, plan.approved), outputEvents(plan.rejected))
        })(),
      ),
    )
    const by = byCallId(resultsFrom(collected))
    expect(by.get("c1")).toMatchObject({ _tag: "Value" })
    expect(by.get("c2")).toMatchObject({ _tag: "Failure", kind: "unknown_tool" })
    expect(by.get("c3")).toMatchObject({ _tag: "Value", value: { status: "dropped" } })
  })
})

// ---------------------------------------------------------------------------
// fromVerdictQueue: WebSocket-style scenarios
// ---------------------------------------------------------------------------

describe("fromVerdictQueue + executeAll", () => {
  it("queue-driven: approve + deny resolve correctly with ApprovalRequested events", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const verdicts = yield* Queue.unbounded<{
          readonly call_id: string
          readonly decision: "approve" | "deny"
          readonly reason?: string
        }>()
        yield* Queue.offer(verdicts, { call_id: "c2", decision: "approve" })
        yield* Queue.offer(verdicts, {
          call_id: "c3",
          decision: "deny",
          reason: "too risky",
        })

        // Stream.unwrap supplies the Scope for fromVerdictQueue's router.
        const events = Stream.unwrap(
          Effect.gen(function* () {
            const { approved, decisions, announce } = yield* fromVerdictQueue(
              isSensitive,
              verdicts,
            )(calls)
            return Stream.merge(
              announce,
              Stream.merge(
                executeAll(allTools, approved),
                decisions.pipe(Stream.flatMap(eventsFromDecision)),
              ),
            )
          }),
        )
        return yield* Stream.runCollect(events)
      }),
    )

    expect(collected.filter(isApprovalRequested)).toHaveLength(2)

    const by = byCallId(resultsFrom(collected))
    expect(by.get("c2")).toMatchObject({ _tag: "Value", value: { status: "sent" } })
    expect(by.get("c3")).toMatchObject({
      _tag: "Failure",
      kind: "denied",
      reason: "too risky",
    })
  })
})

// ---------------------------------------------------------------------------
// History reconciliation
// ---------------------------------------------------------------------------

describe("findUnansweredCalls / cancelAllPending / isReconciled", () => {
  const orphan = fc("c99", "delete_database", { name: "prod" })
  const answered = fc("c98", "web_search", { query: "x" })
  const answeredOutput = Items.functionCallOutput("c98", JSON.stringify({ count: 0 }))

  it("findUnansweredCalls returns only orphans", () => {
    const history = [Items.userText("hi"), answered, orphan, answeredOutput]
    const unanswered = findUnansweredCalls(history)
    expect(unanswered).toHaveLength(1)
    expect(unanswered[0]!.call_id).toBe("c99")
  })

  it("isReconciled is false when orphans exist, true otherwise", () => {
    const stale = [Items.userText("hi"), orphan]
    expect(isReconciled(stale)).toBe(false)
    const reconciled = [...stale, ...cancelAllPending(stale).map(toFunctionCallOutput)]
    expect(isReconciled(reconciled)).toBe(true)
  })

  it("cancelAllPending synthesizes one Failure(cancelled) per orphan", () => {
    const history = [Items.userText("hi"), answered, orphan, answeredOutput]
    const closures = cancelAllPending(history, "user moved on")
    expect(closures).toHaveLength(1)
    const c = closures[0]!
    expect(isFailure(c)).toBe(true)
    expect(c).toMatchObject({
      _tag: "Failure",
      call_id: "c99",
      kind: "cancelled",
      reason: "user moved on",
    })
  })

  it("follow-up: map closures to FunctionCallOutput before appending new user message", () => {
    const stale = [Items.userText("first request"), orphan]
    const closures = cancelAllPending(stale, "user redirected")
    const reconciled = [
      ...stale,
      ...closures.map(toFunctionCallOutput),
      Items.userText("never mind"),
    ]
    expect(findUnansweredCalls(reconciled)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Wire conversion
// ---------------------------------------------------------------------------

describe("toFunctionCallOutput", () => {
  it("round-trips a Value result", () => {
    const r: ToolResult = {
      _tag: "Value",
      call_id: "c1",
      tool: "web_search",
      value: { count: 3 },
    }
    const out = toFunctionCallOutput(r)
    expect(out.call_id).toBe("c1")
    expect(JSON.parse(out.output)).toEqual({ count: 3 })
  })

  it("round-trips a Failure result with reason", () => {
    const r: ToolResult = {
      _tag: "Failure",
      call_id: "c2",
      tool: "bulk_email",
      kind: "denied",
      reason: "spam concern",
    }
    const out = toFunctionCallOutput(r)
    expect(JSON.parse(out.output)).toEqual({ kind: "denied", reason: "spam concern" })
  })

  it("round-trips a Failure result without reason (omits the field)", () => {
    const r: ToolResult = {
      _tag: "Failure",
      call_id: "c3",
      tool: "delete_database",
      kind: "cancelled",
    }
    const out = toFunctionCallOutput(r)
    expect(JSON.parse(out.output)).toEqual({ kind: "cancelled" })
  })
})

// ---------------------------------------------------------------------------
// executeAll
// ---------------------------------------------------------------------------

describe("executeAll", () => {
  it("runs all calls passed to it", async () => {
    const collected = await Effect.runPromise(Stream.runCollect(executeAll(allTools, calls)))
    expect(collected.filter(isOutput)).toHaveLength(3)
    expect(collected.filter(isOutput).every((e) => isValue(e.result))).toBe(true)
  })
})
