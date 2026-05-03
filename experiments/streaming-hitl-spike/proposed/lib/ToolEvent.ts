/**
 * Library: the event type emitted by `executeWithApproval`. Three variants
 * cover the full lifecycle of a streamed, possibly approval-gated tool
 * call.
 *
 * In the framework this would live somewhere like
 * `@effect-uai/core/Toolkit` or its own `ToolEvent` module.
 */
import type * as Items from "@effect-uai/core/Items"

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
  | { readonly _tag: "Output"; readonly output: Items.FunctionCallOutput }

export const isApprovalRequested = (
  e: ToolEvent,
): e is Extract<ToolEvent, { _tag: "ApprovalRequested" }> => e._tag === "ApprovalRequested"

export const isIntermediate = (
  e: ToolEvent,
): e is Extract<ToolEvent, { _tag: "Intermediate" }> => e._tag === "Intermediate"

export const isOutput = (e: ToolEvent): e is Extract<ToolEvent, { _tag: "Output" }> =>
  e._tag === "Output"
