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

export const isApprovalRequested: (
  x: ToolEvent,
) => x is Extract<ToolEvent, { readonly _tag: "ApprovalRequested" }> =
  ToolEvent.$is("ApprovalRequested")
export const isProgress: (x: ToolEvent) => x is Extract<ToolEvent, { readonly _tag: "Progress" }> =
  ToolEvent.$is("Progress")
export const isOutput: (x: ToolEvent) => x is Extract<ToolEvent, { readonly _tag: "Output" }> =
  ToolEvent.$is("Output")
