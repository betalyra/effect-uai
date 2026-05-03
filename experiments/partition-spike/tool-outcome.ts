/**
 * Standardized JSON shapes carried inside `FunctionCallOutput.output` for
 * non-success outcomes. This is a separate concern from the partition
 * primitive - it applies to *every* recipe that produces synthetic
 * outputs (HITL approval, per-tool timeouts, sub-agent failures,
 * argument validation failures, etc.).
 *
 * ## Why this matters
 *
 * Today, three different conventions coexist:
 *
 *   - `Toolkit.defaultRepair`: `{ error: "argument_validation_failed",
 *                                 tool, message }`
 *   - hand-rolled denial output:  `{ error: "denied_by_user", reason }`
 *   - hand-rolled cancellation:   `{ status: "cancelled_by_user", reason }`
 *
 * The model parses these strings, but each shape uses different keys
 * (`error` vs `status`) and different naming. Auditing tools, UIs, and
 * replay infrastructure can't introspect them as a single type.
 *
 * ## Design
 *
 * One tagged union, one discriminator field (`kind`, lowercase, snake-
 * case for LLM friendliness), one Schema:
 *
 *   - `Success`         - rarely written; tool's output is the bare value
 *                         today. This tag exists so introspection code can
 *                         have a uniform return type.
 *   - `ValidationFailed`- replaces `defaultRepair`'s shape.
 *   - `ExecutionError`  - tool ran but threw. Today this collapses into
 *                         `defaultRepair`; would be useful to separate.
 *   - `Denied`          - HITL: user said no.
 *   - `Cancelled`       - HITL: user moved on without deciding (or timer
 *                         fired). Required by every provider when a
 *                         function_call is left unanswered.
 *   - `Timeout`         - per-tool timeout fired (future recipe).
 *
 * Success outputs stay UNWRAPPED in `FunctionCallOutput.output` - that
 * is, today's behavior. Tool authors keep returning `Output`; the
 * framework `JSON.stringify`s it directly. Only non-success outcomes
 * carry the `kind` tag. This keeps the wire format backwards compatible
 * for tools that already work and avoids forcing the model to learn a
 * wrapper schema for every successful call.
 *
 * ## Migration cost
 *
 * `Toolkit.defaultRepair`'s output shape changes from
 * `{ error: "argument_validation_failed", ... }` to
 * `{ kind: "validation_failed", ... }`. This is breaking on the wire,
 * but the only consumer is the model itself - and models are robust to
 * key renames if the surrounding tool description signals the change.
 * Ship a `legacyDefaultRepair` shim if needed during transition.
 */
import { Schema } from "effect"
import {
  functionCallOutput,
  type FunctionCall,
  type FunctionCallOutput,
} from "@effect-uai/core/Items"

// ---------------------------------------------------------------------------
// ToolFailure - tagged union of every non-success outcome the framework
// can synthesize on a tool author's behalf.
// ---------------------------------------------------------------------------

export const ValidationFailed = Schema.Struct({
  kind: Schema.Literal("validation_failed"),
  tool: Schema.String,
  message: Schema.String,
})
export type ValidationFailed = typeof ValidationFailed.Type

export const ExecutionError = Schema.Struct({
  kind: Schema.Literal("execution_error"),
  tool: Schema.String,
  message: Schema.String,
})
export type ExecutionError = typeof ExecutionError.Type

export const Denied = Schema.Struct({
  kind: Schema.Literal("denied"),
  reason: Schema.String,
})
export type Denied = typeof Denied.Type

export const Cancelled = Schema.Struct({
  kind: Schema.Literal("cancelled"),
  reason: Schema.String,
})
export type Cancelled = typeof Cancelled.Type

export const Timeout = Schema.Struct({
  kind: Schema.Literal("timeout"),
  tool: Schema.String,
  afterMs: Schema.Number,
})
export type Timeout = typeof Timeout.Type

export const ToolFailure = Schema.Union([
  ValidationFailed,
  ExecutionError,
  Denied,
  Cancelled,
  Timeout,
])
export type ToolFailure = typeof ToolFailure.Type

export const isValidationFailed = (f: ToolFailure): f is ValidationFailed =>
  f.kind === "validation_failed"
export const isExecutionError = (f: ToolFailure): f is ExecutionError => f.kind === "execution_error"
export const isDenied = (f: ToolFailure): f is Denied => f.kind === "denied"
export const isCancelled = (f: ToolFailure): f is Cancelled => f.kind === "cancelled"
export const isTimeout = (f: ToolFailure): f is Timeout => f.kind === "timeout"

// ---------------------------------------------------------------------------
// Constructors - emit a `FunctionCallOutput` whose `output` string
// JSON-decodes into the matching `ToolFailure` variant.
// ---------------------------------------------------------------------------

export const denied = (call: FunctionCall, reason?: string): FunctionCallOutput =>
  functionCallOutput(
    call.call_id,
    JSON.stringify({
      kind: "denied",
      reason: reason ?? "User denied this call.",
    } satisfies Denied),
  )

export const cancelled = (call: FunctionCall, reason?: string): FunctionCallOutput =>
  functionCallOutput(
    call.call_id,
    JSON.stringify({
      kind: "cancelled",
      reason: reason ?? "User moved on before approving or denying this call.",
    } satisfies Cancelled),
  )

export const validationFailed = (
  call: FunctionCall,
  tool: string,
  message: string,
): FunctionCallOutput =>
  functionCallOutput(
    call.call_id,
    JSON.stringify({ kind: "validation_failed", tool, message } satisfies ValidationFailed),
  )

export const executionError = (
  call: FunctionCall,
  tool: string,
  message: string,
): FunctionCallOutput =>
  functionCallOutput(
    call.call_id,
    JSON.stringify({ kind: "execution_error", tool, message } satisfies ExecutionError),
  )

// ---------------------------------------------------------------------------
// Introspection - parse a `FunctionCallOutput` back into its tagged shape
// (or `null` for "this is a regular successful tool output, not a
// framework-synthesized failure"). Useful for audit logs, replay tooling,
// and UI rendering.
// ---------------------------------------------------------------------------

const decode = Schema.decodeUnknownOption(ToolFailure)

export const parseFailure = (output: FunctionCallOutput): ToolFailure | null => {
  try {
    const parsed = JSON.parse(output.output) as unknown
    const result = decode(parsed)
    return result._tag === "Some" ? result.value : null
  } catch {
    return null
  }
}
