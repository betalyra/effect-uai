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
import { Schema } from "effect"
import { ToolResult } from "./ToolResult.js"

const ToolEventSchema = Schema.TaggedUnion({
  ApprovalRequested: {
    call_id: Schema.String,
    tool: Schema.String,
    arguments: Schema.String,
  },
  Progress: {
    call_id: Schema.String,
    tool: Schema.String,
    data: Schema.Unknown,
  },
  Output: {
    result: ToolResult,
  },
})

export type ToolEvent = typeof ToolEventSchema.Type

/**
 * Namespace of constructors, type guards, and matchers for `ToolEvent`,
 * provided by `Schema.TaggedUnion`. Use `ToolEvent.Output({ result })` to build
 * an event, `ToolEvent.guards.Output` for type narrowing,
 * `ToolEvent.match({ ApprovalRequested, Progress, Output })` for
 * exhaustive pattern matching.
 */
export const ToolEvent = Object.assign(ToolEventSchema, {
  ApprovalRequested: (input: Parameters<typeof ToolEventSchema.cases.ApprovalRequested.make>[0]) =>
    ToolEventSchema.cases.ApprovalRequested.make(input),
  Progress: (input: Parameters<typeof ToolEventSchema.cases.Progress.make>[0]) =>
    ToolEventSchema.cases.Progress.make(input),
  Output: (input: Parameters<typeof ToolEventSchema.cases.Output.make>[0]) =>
    ToolEventSchema.cases.Output.make(input),
})

export const isApprovalRequested = ToolEvent.guards.ApprovalRequested
export const isProgress = ToolEvent.guards.Progress
export const isOutput = ToolEvent.guards.Output
