/**
 * Post-execution and synthetic tool results.
 *
 *   - Executed tools emit ToolResult.Value.
 *   - Approval/cancellation policy emits synthetic ToolResult.Failure.
 *
 * Wire conversion stays at the recipe boundary via `toFunctionCallOutput`
 * so recipes can inspect, redact, or audit values before serialization.
 *
 * `output` and `reason` are `string`, not `unknown`: the wire wants strings,
 * and `unknown` would invite non-serializable values (Date, Map, BigInt,
 * fn). Recipes that want structured detail JSON.stringify themselves.
 */
import { Match } from "effect"
import type { FunctionCall, FunctionCallOutput } from "../domain/Items.js"
import { functionCallOutput } from "../domain/Items.js"

// ---------------------------------------------------------------------------
// ToolResult
// ---------------------------------------------------------------------------

export type ToolResult =
  | {
      readonly _tag: "Value"
      readonly call_id: string
      readonly tool: string
      readonly value: unknown
    }
  | {
      readonly _tag: "Failure"
      readonly call_id: string
      readonly tool: string
      readonly kind: string
      readonly reason?: string
    }

export const isValue = (r: ToolResult): r is Extract<ToolResult, { _tag: "Value" }> =>
  r._tag === "Value"

export const isFailure = (r: ToolResult): r is Extract<ToolResult, { _tag: "Failure" }> =>
  r._tag === "Failure"

// Synthesizers. `denied` and `cancelled` are operationally distinct;
// anything else is just a recipe-chosen `kind` via `rejected`.
// ---------------------------------------------------------------------------

export const rejected = (
  call: FunctionCall,
  kind: string,
  reason?: string,
): ToolResult => ({
  _tag: "Failure",
  call_id: call.call_id,
  tool: call.name,
  kind,
  ...(reason !== undefined ? { reason } : {}),
})

/** Explicit user/policy rejection. */
export const denied = (call: FunctionCall, reason?: string): ToolResult =>
  rejected(call, "denied", reason)

/** Implicit non-answer (follow-up, inactivity, abort). */
export const cancelled = (call: FunctionCall, reason?: string): ToolResult =>
  rejected(call, "cancelled", reason)

/** Tool's own execution failed (parse error, schema, runtime crash). */
export const executionError = (call: FunctionCall, reason: string): ToolResult =>
  rejected(call, "execution_error", reason)

// ---------------------------------------------------------------------------
// Wire conversion - the one place structured → string happens.
// ---------------------------------------------------------------------------

export const toFunctionCallOutput = (r: ToolResult): FunctionCallOutput =>
  Match.value(r).pipe(
    Match.tag("Value", (v) => functionCallOutput(v.call_id, JSON.stringify(v.value))),
    Match.tag("Failure", (f) =>
      functionCallOutput(
        f.call_id,
        JSON.stringify(
          f.reason !== undefined ? { kind: f.kind, reason: f.reason } : { kind: f.kind },
        ),
      ),
    ),
    Match.exhaustive,
  )
