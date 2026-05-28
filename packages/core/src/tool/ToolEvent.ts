/**
 * The event type emitted while handling tool calls.
 *
 *   - ApprovalRequested : gated calls waiting for approval
 *   - Progress          : per-element passthrough from a streaming tool's run
 *   - Output            : terminal result (carries a structured ToolResult)
 *
 * Recipes thread `ToolEvent.Output.result` through `continueWithResults` and
 * apply `toToolCallOutput` when appending to history.
 */
import { Data } from "effect"
import type { ToolResult } from "./ToolResult.js"

export type ToolEvent = Data.TaggedEnum<{
  ApprovalRequested: {
    readonly call_id: string
    readonly tool: string
    readonly arguments: string
  }
  Progress: {
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
 * `ToolEvent.$match({ ApprovalRequested, Progress, Output })` for
 * exhaustive pattern matching.
 */
export const ToolEvent = Data.taggedEnum<ToolEvent>()

export const isApprovalRequested = ToolEvent.$is("ApprovalRequested")
export const isProgress = ToolEvent.$is("Progress")
export const isOutput = ToolEvent.$is("Output")
