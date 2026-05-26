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
import { Schema } from "effect"
import type { ToolCall, ToolCallOutput } from "../domain/Items.js"
import { toolCallOutput } from "../domain/Items.js"

// ---------------------------------------------------------------------------
// ToolResult
// ---------------------------------------------------------------------------

const ToolResultSchema = Schema.TaggedUnion({
  Ok: {
    call_id: Schema.String,
    tool: Schema.String,
    value: Schema.Unknown,
  },
  Failure: {
    call_id: Schema.String,
    tool: Schema.String,
    kind: Schema.String,
    reason: Schema.optional(Schema.String),
  },
})

export type ToolResult = typeof ToolResultSchema.Type

/**
 * Namespace of constructors, type guards, and matchers for `ToolResult`,
 * provided by `Schema.TaggedUnion`. Use `ToolResult.guards.Ok` for type
 * narrowing and `ToolResult.match({ Ok, Failure })` for exhaustive
 * pattern matching. Synthetic-result helpers (`denied`, `cancelled`,
 * `executionError`, `failed`) below are kinder constructors than the
 * raw `ToolResult.Failure(...)`.
 */
export const ToolResult = Object.assign(ToolResultSchema, {
  Ok: (input: Parameters<typeof ToolResultSchema.cases.Ok.make>[0]) =>
    ToolResultSchema.cases.Ok.make(input),
  Failure: (input: Parameters<typeof ToolResultSchema.cases.Failure.make>[0]) =>
    ToolResultSchema.cases.Failure.make(input),
})

export const isOk = ToolResult.guards.Ok
export const isFailure = ToolResult.guards.Failure

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

/** Tool's own execution failed (parse error, schema, runtime crash). */
export const executionError = (call: ToolCall, reason: string): ToolResult =>
  failed(call, "execution_error", reason)

// ---------------------------------------------------------------------------
// Wire conversion - the one place structured → string happens.
// ---------------------------------------------------------------------------

export const toToolCallOutput = (r: ToolResult): ToolCallOutput =>
  ToolResult.match(r, {
    Ok: (v) => toolCallOutput(v.call_id, JSON.stringify(v.value)),
    Failure: (f) =>
      toolCallOutput(
        f.call_id,
        JSON.stringify(
          f.reason !== undefined ? { kind: f.kind, reason: f.reason } : { kind: f.kind },
        ),
      ),
  })
