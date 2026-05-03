/**
 * Library: the event type emitted by `executeWithResolver`. Three variants
 * cover the full lifecycle of an approval-gated, possibly streaming tool
 * call.
 *
 * `Output.result` is a `ToolResult` (structured), not a `FunctionCallOutput`
 * (wire). The recipe applies `toFunctionCallOutput` when threading into
 * history.
 */
import type { ToolResult } from "./Outcome.js"

export type ToolEvent =
  | {
      readonly _tag: "ApprovalRequested"
      readonly call_id: string
      readonly tool: string
      readonly arguments: string
    }
  | {
      readonly _tag: "Intermediate"
      readonly call_id: string
      readonly tool: string
      readonly data: unknown
    }
  | { readonly _tag: "Output"; readonly result: ToolResult }

export const isApprovalRequested = (
  e: ToolEvent,
): e is Extract<ToolEvent, { _tag: "ApprovalRequested" }> => e._tag === "ApprovalRequested"

export const isIntermediate = (
  e: ToolEvent,
): e is Extract<ToolEvent, { _tag: "Intermediate" }> => e._tag === "Intermediate"

export const isOutput = (e: ToolEvent): e is Extract<ToolEvent, { _tag: "Output" }> =>
  e._tag === "Output"
