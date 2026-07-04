/**
 * Post-execution and synthetic tool results.
 *
 *   - Executed tools emit ToolResult.Ok.
 *   - Approval/cancellation policy emits synthetic ToolResult.Failure.
 *
 * Wire conversion stays at the recipe boundary via `toToolCallOutput`
 * so recipes can inspect, redact, or audit values before serialization.
 *
 * `output` and `reason` are `string`, not `unknown`: the wire wants strings,
 * and `unknown` would invite non-serializable values (Date, Map, BigInt,
 * fn). Recipes that want structured detail JSON.stringify themselves.
 */
import { Data } from "effect"
import type { ToolCall, ToolCallOutput } from "../domain/Items.js"
import { toolCallOutput } from "../domain/Items.js"

// ---------------------------------------------------------------------------
// ToolResult
// ---------------------------------------------------------------------------

export type ToolResult = Data.TaggedEnum<{
  Ok: {
    readonly call_id: string
    readonly tool: string
    readonly value: unknown
  }
  Failure: {
    readonly call_id: string
    readonly tool: string
    readonly kind: string
    readonly reason?: string
  }
}>

/**
 * Namespace of constructors, type guards, and matchers for `ToolResult`,
 * provided by `Data.taggedEnum`. Use `ToolResult.$is("Ok")` for type
 * narrowing and `ToolResult.$match({ Ok, Failure })` for exhaustive
 * pattern matching. Synthetic-result helpers (`denied`, `cancelled`,
 * `executionError`, `failed`) below are kinder constructors than the
 * raw `ToolResult.Failure(...)`.
 */
export const ToolResult = Data.taggedEnum<ToolResult>()

export const isOk = ToolResult.$is("Ok")
export const isFailure = ToolResult.$is("Failure")

// Synthesizers. `denied` and `cancelled` are operationally distinct;
// anything else is just a recipe-chosen `kind` via `failed`.
// ---------------------------------------------------------------------------

export const failed = (call: ToolCall, kind: string, reason?: string): ToolResult =>
  ToolResult.Failure({
    call_id: call.call_id,
    tool: call.name,
    kind,
    ...(reason !== undefined ? { reason } : {}),
  })

/** Explicit user/policy rejection. */
export const denied = (call: ToolCall, reason?: string): ToolResult =>
  failed(call, "denied", reason)

/** Implicit non-answer (follow-up, inactivity, abort). */
export const cancelled = (call: ToolCall, reason?: string): ToolResult =>
  failed(call, "cancelled", reason)

/** Tool's own execution failed (JSON parse error, runtime crash). */
export const executionError = (call: ToolCall, reason: string): ToolResult =>
  failed(call, "execution_error", reason)

/**
 * The model called a tool that is visible to it but has no local executor — a
 * provider-hosted, signal, or interaction tool routed through `Toolkit.run`.
 * Distinct from `unknown_tool` (no such tool at all): the loop is expected to
 * intercept these kinds before execution, so this kind flags a missing handler.
 */
export const nonLocalTool = (call: ToolCall, reason?: string): ToolResult =>
  failed(
    call,
    "non_local_tool",
    reason ?? `Tool "${call.name}" is visible to the model but has no local executor`,
  )

/**
 * The model's `arguments` failed the tool's input schema. Distinct kind from
 * `execution_error` so recipes can tell a contract violation apart from a
 * runtime crash.
 */
export const validationError = (call: ToolCall, reason?: string): ToolResult =>
  failed(call, "input_validation_error", reason ?? "Tool input failed schema validation")

// ---------------------------------------------------------------------------
// Wire conversion - the one place structured → string happens.
// ---------------------------------------------------------------------------

/**
 * Serialize a success value for the wire. A `string` passes through raw
 * (models read plain text best; JSON.stringify would quote and escape it);
 * `undefined` becomes `"null"`; anything else is JSON.
 */
export const serializeValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? null)

/** The one failure shape the model sees: `{"error":{"kind","message"}}`. */
const failureBody = (kind: string, message?: string): string =>
  JSON.stringify({ error: message !== undefined ? { kind, message } : { kind } })

export const toToolCallOutput = (r: ToolResult): ToolCallOutput =>
  ToolResult.$match(r, {
    Ok: (v) => toolCallOutput(v.call_id, serializeValue(v.value)),
    Failure: (f) => toolCallOutput(f.call_id, failureBody(f.kind, f.reason)),
  })
