/**
 * The event type emitted while handling tool calls.
 *
 *   - ApprovalRequested : gated calls waiting for approval
 *   - Intermediate      : per-element passthrough from a streaming tool's run
 *   - Output            : terminal result (carries a structured ToolResult)
 *
 * Recipes thread `ToolEvent.Output.result` through `nextStateFrom` and apply
 * `toFunctionCallOutput` when appending to history.
 */
import { Data } from "effect"
import type { ToolResult } from "./Outcome.js"

export type ToolEvent = Data.TaggedEnum<{
  ApprovalRequested: {
    readonly call_id: string
    readonly tool: string
    readonly arguments: string
  }
  Intermediate: {
    readonly call_id: string
    readonly tool: string
    readonly data: unknown
  }
  Output: {
    readonly result: ToolResult
  }
}>

/**
 * Namespace of constructors, type guards, and matchers for `ToolEvent`,
 * provided by `Data.taggedEnum`. Use `ToolEvent.Output({ result })` to build
 * an event, `ToolEvent.$is("Output")` for type narrowing,
 * `ToolEvent.$match({ ApprovalRequested, Intermediate, Output })` for
 * exhaustive pattern matching.
 */
export const ToolEvent = Data.taggedEnum<ToolEvent>()

export const isApprovalRequested = ToolEvent.$is("ApprovalRequested")
export const isIntermediate = ToolEvent.$is("Intermediate")
export const isOutput = ToolEvent.$is("Output")
