/**
 * Approval helpers. They only decide which calls are approved and which
 * synthetic results go back to the model; tool execution stays explicit via
 * `Toolkit.run`. A long-lived verdict channel is app code (see the
 * `tool-call-approval` recipe).
 */
import { Data } from "effect"
import type { ToolCall } from "../domain/Items.js"
import { type ToolResult, cancelled, denied } from "./ToolResult.js"
import { ToolEvent } from "./ToolEvent.js"

export type ToolCallPlan = {
  readonly approved: ReadonlyArray<ToolCall>
  readonly rejected: ReadonlyArray<ToolResult>
}

export type ApprovalDecision = Data.TaggedEnum<{
  Approved: { readonly call: ToolCall }
  Rejected: { readonly result: ToolResult }
}>

export const ApprovalDecision = Data.taggedEnum<ApprovalDecision>()

export const approve = (call: ToolCall): ApprovalDecision => ApprovalDecision.Approved({ call })

export const reject = (result: ToolResult): ApprovalDecision =>
  ApprovalDecision.Rejected({ result })

export const splitApprovalDecisions = (decisions: ReadonlyArray<ApprovalDecision>): ToolCallPlan =>
  decisions.reduce<ToolCallPlan>(
    (acc, decision) =>
      decision._tag === "Approved"
        ? { ...acc, approved: [...acc.approved, decision.call] }
        : { ...acc, rejected: [...acc.rejected, decision.result] },
    { approved: [], rejected: [] },
  )

export const approvalRequested = (call: ToolCall): ToolEvent =>
  ToolEvent.ApprovalRequested({
    call_id: call.call_id,
    tool: call.name,
    arguments: call.arguments,
  })

// ---------------------------------------------------------------------------
// Approval map: verdicts arrive bundled with the request. Missing → cancelled.
// ---------------------------------------------------------------------------

export type ApprovalMapEntry =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason?: string }

export const fromMap =
  (predicate: (call: ToolCall) => boolean, approvals: ReadonlyMap<string, ApprovalMapEntry>) =>
  (calls: ReadonlyArray<ToolCall>): ToolCallPlan =>
    splitApprovalDecisions(
      calls.map((call) => {
        if (!predicate(call)) return approve(call)
        const v = approvals.get(call.call_id)
        if (v === undefined) return reject(cancelled(call))
        return v.decision === "approve" ? approve(call) : reject(denied(call, v.reason))
      }),
    )
