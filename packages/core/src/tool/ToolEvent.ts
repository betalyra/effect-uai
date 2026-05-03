/**
 * The event type emitted by `Toolkit.executeAllWithResolver`.
 *
 *   - ApprovalRequested : gated calls before resolver returns
 *   - Intermediate      : per-element passthrough from a streaming tool's run
 *   - Output            : terminal result (carries a structured ToolResult)
 *
 * Recipes thread `ToolEvent.Output.result` through `nextStateFrom` and apply
 * `toFunctionCallOutput` when appending to history.
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
