/**
 * Library: pre-execution decision + post-execution result type.
 *
 * The executor speaks in `ToolResult` (structured), not `FunctionCallOutput`
 * (wire). This lets recipes inspect, transform, redact, audit, or re-route
 * tool values BEFORE serialization without having to parse-and-restringify.
 * Wire conversion is one explicit `.map(toFunctionCallOutput)` at the
 * recipe boundary.
 *
 * `ToolResult` is a two-tag discriminated union:
 *
 *   - Value(call_id, tool, value)         : tool produced this output
 *   - Failure(call_id, tool, kind, reason): synthesized non-execution
 *
 * The `kind` field on Failure is open: the lib blesses two canonical kinds
 * because they're operationally distinct:
 *
 *   - `denied`    : explicit user/policy rejection (we know "no")
 *   - `cancelled` : implicit, no answer arrived (follow-up, timeout, ...)
 *
 * Anything else (permission_denied, rate_limited, sandboxed, ...) is just
 * a recipe-level kind via `rejected(call, kind, reason)`.
 *
 * Why structured ToolResult on the executor side, but `string` on the wire
 * (`FunctionCallOutput.output`)? The wire wants a string (every provider).
 * Holding the wire-form `unknown` invites non-serializable values to slip
 * through. Holding it structured BEFORE the wire keeps recipes ergonomic.
 * Both shapes have their place; we serialize once at the recipe's edge.
 *
 * Why `reason: string` (not unknown / object)? `unknown` doesn't guarantee
 * JSON-serializability. Recipes that want structured detail call
 * `JSON.stringify(detail)` themselves and pass the resulting string.
 */
import { Match } from "effect"
import * as Items from "@effect-uai/core/Items"

// ---------------------------------------------------------------------------
// ToolResult - the executor's structured output type.
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

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type ToolDecision =
  | { readonly _tag: "Execute" }
  | { readonly _tag: "Reject"; readonly result: ToolResult }

export const execute: ToolDecision = { _tag: "Execute" }

export const reject = (result: ToolResult): ToolDecision => ({
  _tag: "Reject",
  result,
})

// ---------------------------------------------------------------------------
// Synthesizers - generic constructor + two named conveniences. All return
// ToolResult.Failure (structured), NOT FunctionCallOutput (wire).
// ---------------------------------------------------------------------------

/**
 * Generic synthesized failure. `kind` is open: pass any string the recipe
 * wants to pattern-match on later (e.g. `"permission_denied"`,
 * `"rate_limited"`, `"sandboxed"`).
 */
export const rejected = (
  call: Items.FunctionCall,
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
export const denied = (call: Items.FunctionCall, reason?: string): ToolResult =>
  rejected(call, "denied", reason)

/** Implicit non-answer (follow-up, inactivity, abort). */
export const cancelled = (call: Items.FunctionCall, reason?: string): ToolResult =>
  rejected(call, "cancelled", reason)

/**
 * Tool's own execution failed. Mirrors `Toolkit.defaultRepair` but produces
 * a structured `ToolResult.Failure` instead of a wire-form
 * `FunctionCallOutput`. Use kind `"execution_error"` so recipes can route
 * tool failures consistently.
 */
export const executionError = (
  call: Items.FunctionCall,
  reason: string,
): ToolResult => rejected(call, "execution_error", reason)

// ---------------------------------------------------------------------------
// Wire conversion - the explicit boundary recipes hit when appending to
// history. One place where structured → string happens.
// ---------------------------------------------------------------------------

export const toFunctionCallOutput = (r: ToolResult): Items.FunctionCallOutput =>
  Match.value(r).pipe(
    Match.tag("Value", (v) =>
      Items.functionCallOutput(v.call_id, JSON.stringify(v.value)),
    ),
    Match.tag("Failure", (f) =>
      Items.functionCallOutput(
        f.call_id,
        JSON.stringify(
          f.reason !== undefined ? { kind: f.kind, reason: f.reason } : { kind: f.kind },
        ),
      ),
    ),
    Match.exhaustive,
  )
