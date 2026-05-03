/**
 * End-to-end tests for the HTTP recipe. Covers the four scenarios that
 * matter on the wire:
 *
 *   1. All approved   → tools execute, structured outputs land in history.
 *   2. All denied     → no tools execute, denied outputs land in history.
 *   3. Mixed/missing  → some approve, some deny, some omitted (treated as
 *                       cancelled). All three kinds of FunctionCallOutput
 *                       land so history is reconciled before next request.
 *   4. Follow-up      → user sent a new message while approvals were
 *                       pending. Test exercises `cancelAllPending` to
 *                       synthesize closing outputs before continuing.
 *
 * Assertions inspect the structured `ToolResult` directly (no JSON.parse
 * round-trip) - one of the wins of the resolver+ToolResult shape.
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import {
  type ApprovalMapEntry,
  type ToolEvent,
  type ToolResult,
  cancelAllPending,
  findUnansweredCalls,
  isApprovalRequested,
  isFailure,
  isIntermediate,
  isOutput,
  isValue,
  toFunctionCallOutput,
} from "../lib/index.js"
import { type State, buildConversation } from "./conversation-http.js"

const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const turnWithToolCalls: Turn.Turn = {
  stop_reason: "tool_calls",
  usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  items: [
    fc("c1", "web_search", { query: "effect" }),
    fc("c2", "bulk_email", { recipients: ["a@x", "b@x"], subject: "Hi" }),
    fc("c3", "delete_database", { name: "prod" }),
  ],
}

const finalTurn: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done." }],
    },
  ],
}

const isToolEvent = (e: Turn.TurnEvent | ToolEvent): e is ToolEvent => "_tag" in e

const runRecipe = (
  approvals: ReadonlyMap<string, ApprovalMapEntry>,
  initial: State = { history: [Items.userText("Do the thing")] },
) =>
  Effect.runPromise(
    Stream.runCollect(buildConversation(approvals, initial)).pipe(
      Effect.provide(MockProvider.layer([turnWithToolCalls, finalTurn])),
    ),
  )

const resultsFrom = (
  collected: ReadonlyArray<Turn.TurnEvent | ToolEvent>,
): ReadonlyArray<ToolResult> =>
  collected
    .filter(isToolEvent)
    .filter(isOutput)
    .map((e) => e.result)

const byCallId = (results: ReadonlyArray<ToolResult>) =>
  new Map(results.map((r) => [r.call_id, r]))

describe("buildConversation (HTTP / approval map)", () => {
  it("approval scenario: all gated calls approved → tools execute, structured values", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "approve" }],
      ["c3", { decision: "approve" }],
    ])

    const collected = await runRecipe(approvals)
    const results = resultsFrom(collected)
    expect(results).toHaveLength(3)

    const by = byCallId(results)
    const c1 = by.get("c1")!
    const c2 = by.get("c2")!
    const c3 = by.get("c3")!

    expect(isValue(c1)).toBe(true)
    expect((c1 as Extract<ToolResult, { _tag: "Value" }>).value).toMatchObject({ count: 3 })
    expect(isValue(c2)).toBe(true)
    expect((c2 as Extract<ToolResult, { _tag: "Value" }>).value).toMatchObject({
      status: "sent",
      delivered: 2,
    })
    expect(isValue(c3)).toBe(true)
    expect((c3 as Extract<ToolResult, { _tag: "Value" }>).value).toMatchObject({
      status: "dropped",
      name: "prod",
    })

    // Pure-HTTP recipe doesn't emit ApprovalRequested - the request itself
    // already carried the user's decision.
    const approvalReqs = collected.filter(isToolEvent).filter(isApprovalRequested)
    expect(approvalReqs).toHaveLength(0)
  })

  it("denial scenario: gated calls denied → Failure results, no execution", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "deny", reason: "spam concern" }],
      ["c3", { decision: "deny", reason: "prod is sacred" }],
    ])

    const collected = await runRecipe(approvals)

    // No bulk_email progress events (it never ran).
    const intermediates = collected.filter(isToolEvent).filter(isIntermediate)
    expect(intermediates.filter((e) => e.tool === "bulk_email")).toHaveLength(0)
    expect(intermediates.filter((e) => e.tool === "web_search")).toHaveLength(3)

    const by = byCallId(resultsFrom(collected))
    const c2 = by.get("c2")!
    const c3 = by.get("c3")!

    expect(c2).toMatchObject({ _tag: "Failure", kind: "denied", reason: "spam concern" })
    expect(c3).toMatchObject({ _tag: "Failure", kind: "denied", reason: "prod is sacred" })
  })

  it("cancelled scenario: gated calls without verdicts → Failure(cancelled)", async () => {
    const approvals = new Map<string, ApprovalMapEntry>()

    const collected = await runRecipe(approvals)
    const by = byCallId(resultsFrom(collected))

    // c1 (safe) ran normally.
    expect(by.get("c1")).toMatchObject({ _tag: "Value", value: { count: 3 } })

    // c2 and c3 were cancelled because the user submitted no verdicts.
    expect(by.get("c2")).toMatchObject({ _tag: "Failure", kind: "cancelled" })
    expect(by.get("c3")).toMatchObject({ _tag: "Failure", kind: "cancelled" })
  })

  it("mixed scenario: approve, deny, omit → all three kinds present", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "approve" }],
      // c3 omitted → cancelled
    ])

    const collected = await runRecipe(approvals)
    const by = byCallId(resultsFrom(collected))

    expect(by.get("c1")).toMatchObject({ _tag: "Value", value: { count: 3 } })
    expect(by.get("c2")).toMatchObject({ _tag: "Value", value: { status: "sent" } })
    expect(by.get("c3")).toMatchObject({ _tag: "Failure", kind: "cancelled" })
  })

  it("hallucinated tool name: emits Failure(unknown_tool), other calls still execute", async () => {
    // Override one of the scripted calls to a bogus tool name. The other
    // two should still produce normal results; the bogus one yields a
    // synthesized Failure - the turn does not die.
    const hallucinatedTurn: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      items: [
        fc("c1", "web_search", { query: "effect" }),
        fc("c2", "does_not_exist", { whatever: 1 }),
        fc("c3", "delete_database", { name: "prod" }),
      ],
    }
    const collected = await Effect.runPromise(
      Stream.runCollect(
        buildConversation(
          new Map<string, ApprovalMapEntry>([["c3", { decision: "approve" }]]),
          { history: [Items.userText("Do the thing")] },
        ),
      ).pipe(Effect.provide(MockProvider.layer([hallucinatedTurn, finalTurn]))),
    )

    const by = byCallId(resultsFrom(collected))
    expect(by.get("c1")).toMatchObject({ _tag: "Value", value: { count: 3 } })
    expect(by.get("c2")).toMatchObject({
      _tag: "Failure",
      kind: "unknown_tool",
    })
    expect(by.get("c3")).toMatchObject({ _tag: "Value", value: { status: "dropped" } })
  })

  it("toFunctionCallOutput round-trips a Value result", () => {
    const call = fc("c1", "web_search", { query: "effect" })
    const result: ToolResult = {
      _tag: "Value",
      call_id: call.call_id,
      tool: call.name,
      value: { count: 3 },
    }
    const out = toFunctionCallOutput(result)
    expect(out.call_id).toBe("c1")
    expect(JSON.parse(out.output)).toEqual({ count: 3 })
  })

  it("toFunctionCallOutput round-trips a Failure result", () => {
    const call = fc("c2", "bulk_email", {})
    const result: ToolResult = {
      _tag: "Failure",
      call_id: call.call_id,
      tool: call.name,
      kind: "denied",
      reason: "spam concern",
    }
    const out = toFunctionCallOutput(result)
    expect(out.call_id).toBe("c2")
    expect(JSON.parse(out.output)).toEqual({ kind: "denied", reason: "spam concern" })
  })
})

// ---------------------------------------------------------------------------
// Follow-up scenario at the helper level. `cancelAllPending` returns
// ToolResult[]; recipe maps via `toFunctionCallOutput` when appending to
// history.
// ---------------------------------------------------------------------------

describe("history reconciliation (cancelAllPending / findUnansweredCalls)", () => {
  const orphanCall: Items.FunctionCall = fc("c99", "delete_database", { name: "prod" })
  const answeredCall: Items.FunctionCall = fc("c98", "web_search", { query: "x" })
  const answeredOutput: Items.FunctionCallOutput = Items.functionCallOutput(
    "c98",
    JSON.stringify({ count: 0 }),
  )

  it("findUnansweredCalls returns only orphans", () => {
    const history: ReadonlyArray<Items.Item> = [
      Items.userText("hi"),
      answeredCall,
      orphanCall,
      answeredOutput,
    ]
    const unanswered = findUnansweredCalls(history)
    expect(unanswered).toHaveLength(1)
    expect(unanswered[0]!.call_id).toBe("c99")
  })

  it("cancelAllPending synthesizes one Failure(cancelled) per orphan", () => {
    const history: ReadonlyArray<Items.Item> = [
      Items.userText("hi"),
      answeredCall,
      orphanCall,
      answeredOutput,
    ]
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

  it("follow-up: map closures to FunctionCallOutput before appending and adding the new user message", () => {
    const stale: ReadonlyArray<Items.Item> = [
      Items.userText("first request"),
      orphanCall,
    ]
    const closures = cancelAllPending(stale, "user redirected")
    const reconciled: ReadonlyArray<Items.Item> = [
      ...stale,
      ...closures.map(toFunctionCallOutput),
      Items.userText("never mind, do this instead"),
    ]
    expect(findUnansweredCalls(reconciled)).toHaveLength(0)
  })
})
