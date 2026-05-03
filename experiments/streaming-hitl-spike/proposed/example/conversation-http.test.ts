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
 * The HTTP recipe is the simplest carrier for these scenarios: approvals
 * are a synchronous Map, no queue or router fiber. Same primitives apply
 * to the WebSocket recipe.
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import {
  type ApprovalMapEntry,
  type ToolEvent,
  cancelAllPending,
  findUnansweredCalls,
  isApprovalRequested,
  isIntermediate,
  isOutput,
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

const outputsFromCollected = (collected: ReadonlyArray<Turn.TurnEvent | ToolEvent>) =>
  collected
    .filter(isToolEvent)
    .filter(isOutput)
    .map((e) => e.output)

describe("buildConversation (HTTP / approval map)", () => {
  it("approval scenario: all gated calls approved → tools execute, structured outputs", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "approve" }],
      ["c3", { decision: "approve" }],
    ])

    const collected = await runRecipe(approvals)
    const outputs = outputsFromCollected(collected)
    expect(outputs).toHaveLength(3)

    const byId = new Map(outputs.map((o) => [o.call_id, o]))
    expect(JSON.parse(byId.get("c1")!.output)).toMatchObject({ count: 3 })
    expect(JSON.parse(byId.get("c2")!.output)).toMatchObject({ status: "sent", delivered: 2 })
    expect(JSON.parse(byId.get("c3")!.output)).toMatchObject({
      status: "dropped",
      name: "prod",
    })

    // Pure-HTTP recipe doesn't emit ApprovalRequested - the request itself
    // already carried the user's decision.
    const approvalReqs = collected.filter(isToolEvent).filter(isApprovalRequested)
    expect(approvalReqs).toHaveLength(0)
  })

  it("denial scenario: gated calls denied → denied outputs, no execution", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "deny", reason: "spam concern" }],
      ["c3", { decision: "deny", reason: "prod is sacred" }],
    ])

    const collected = await runRecipe(approvals)

    // No bulk_email progress events (it never ran).
    const intermediates = collected.filter(isToolEvent).filter(isIntermediate)
    expect(intermediates.filter((e) => e.tool === "bulk_email")).toHaveLength(0)
    expect(intermediates.filter((e) => e.tool === "web_search")).toHaveLength(3)

    const outputs = outputsFromCollected(collected)
    const byId = new Map(outputs.map((o) => [o.call_id, o]))
    expect(JSON.parse(byId.get("c2")!.output)).toEqual({
      kind: "denied",
      reason: "spam concern",
    })
    expect(JSON.parse(byId.get("c3")!.output)).toEqual({
      kind: "denied",
      reason: "prod is sacred",
    })
  })

  it("cancelled scenario: gated calls without verdicts → cancelled outputs", async () => {
    // Empty approvals map. Both gated calls get synthesized `cancelled`.
    const approvals = new Map<string, ApprovalMapEntry>()

    const collected = await runRecipe(approvals)
    const outputs = outputsFromCollected(collected)
    const byId = new Map(outputs.map((o) => [o.call_id, o]))

    // c1 (safe) ran normally.
    expect(JSON.parse(byId.get("c1")!.output)).toMatchObject({ count: 3 })

    // c2 and c3 were cancelled because the user submitted no verdicts for them.
    expect(JSON.parse(byId.get("c2")!.output)).toEqual({ kind: "cancelled" })
    expect(JSON.parse(byId.get("c3")!.output)).toEqual({ kind: "cancelled" })
  })

  it("mixed scenario: approve, deny, omit → all three kinds present", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c2", { decision: "approve" }],
      // c3 omitted → cancelled
    ])

    const collected = await runRecipe(approvals)
    const outputs = outputsFromCollected(collected)
    const byId = new Map(outputs.map((o) => [o.call_id, o]))

    expect(JSON.parse(byId.get("c1")!.output)).toMatchObject({ count: 3 })
    expect(JSON.parse(byId.get("c2")!.output)).toMatchObject({ status: "sent" })
    expect(JSON.parse(byId.get("c3")!.output)).toEqual({ kind: "cancelled" })
  })
})

// ---------------------------------------------------------------------------
// Follow-up scenario tested at the helper level - the recipe author calls
// these BEFORE submitting the next provider request when state was left
// with orphan calls (e.g. user sent a new message mid-approval, or a
// stateless HTTP server reconstructed history from a stale checkpoint).
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

  it("cancelAllPending synthesizes one cancelled output per orphan", () => {
    const history: ReadonlyArray<Items.Item> = [
      Items.userText("hi"),
      answeredCall,
      orphanCall,
      answeredOutput,
    ]
    const closures = cancelAllPending(history, "user moved on")
    expect(closures).toHaveLength(1)
    expect(closures[0]!.call_id).toBe("c99")
    expect(JSON.parse(closures[0]!.output)).toEqual({
      kind: "cancelled",
      reason: "user moved on",
    })
  })

  it("follow-up: append cancelAllPending(history) before adding the new user message", () => {
    // Simulating: previous turn left c99 unanswered; user sent a new message.
    // Recipe pattern: reconcile first, then append the new turn.
    const stale: ReadonlyArray<Items.Item> = [
      Items.userText("first request"),
      orphanCall,
    ]
    const closures = cancelAllPending(stale, "user redirected")
    const reconciled: ReadonlyArray<Items.Item> = [
      ...stale,
      ...closures,
      Items.userText("never mind, do this instead"),
    ]
    expect(findUnansweredCalls(reconciled)).toHaveLength(0)
  })
})
