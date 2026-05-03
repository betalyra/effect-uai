/**
 * Library: pre-execution decision and post-execution synthesizers.
 *
 * `ToolDecision` is the verdict a resolver returns for each pending call.
 * Two shapes cover everything:
 *
 *   - Execute        : run the tool
 *   - Reject(output) : skip execution, emit this synthetic output
 *
 * Argument-rewriting use cases (sanitize, redact, "approve with edits")
 * compose as a Resolver→Resolver wrapper that mutates `call.arguments`
 * before delegating to the inner resolver. They don't need to be in
 * the decision type.
 *
 * Synthesized output shape: `{ kind: string, reason?: string }` JSON-encoded
 * into `FunctionCallOutput.output`. The lib blesses two canonical kinds
 * because they're operationally distinct:
 *
 *   - `denied`    : explicit user/policy rejection (we know "no")
 *   - `cancelled` : implicit, no answer arrived (follow-up, timeout, ...)
 *
 * Anything else (permission_denied, rate_limited, sandboxed, ...) is just
 * a recipe-level kind via `rejected(call, kind, reason)`. The executor
 * doesn't inspect `kind`; it's metadata for downstream pattern-matching,
 * audit trails, or analytics.
 *
 * Why `output: string` (not `unknown`)? The wire wants a string (every
 * provider). Holding it structured forces JSON.stringify on every send
 * and invites non-serializable values (Date, Map, fn) to slip through.
 * Serialize once at the executor's edge; stay wire-faithful.
 *
 * Why `reason: string` (not `unknown` / object)? Same reasoning, applied
 * one level deeper. `unknown` doesn't guarantee JSON-serializability;
 * `JSON.stringify(new Date())` silently coerces, `JSON.stringify(BigInt)`
 * throws, `JSON.stringify(new Map())` becomes `{}`. With `string` we're
 * correct-by-construction. Recipes that want structured detail call
 * `JSON.stringify(detail)` themselves and pass the result.
 */
import * as Items from "@effect-uai/core/Items"

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type ToolDecision =
  | { readonly _tag: "Execute" }
  | { readonly _tag: "Reject"; readonly output: Items.FunctionCallOutput }

export const execute: ToolDecision = { _tag: "Execute" }

export const reject = (output: Items.FunctionCallOutput): ToolDecision => ({
  _tag: "Reject",
  output,
})

// ---------------------------------------------------------------------------
// Synthesized outputs - generic constructor + two named conveniences.
// `reason` is genuinely optional: omit it when `kind` says enough on its
// own; pass a sentence when there's something to clarify.
// ---------------------------------------------------------------------------

/**
 * Generic synthesized output. `kind` is open: pass any string the recipe
 * wants to pattern-match on later (e.g. `"permission_denied"`,
 * `"rate_limited"`, `"sandboxed"`).
 */
export const rejected = (
  call: Items.FunctionCall,
  kind: string,
  reason?: string,
): Items.FunctionCallOutput =>
  Items.functionCallOutput(
    call.call_id,
    JSON.stringify(reason !== undefined ? { kind, reason } : { kind }),
  )

/** Explicit user/policy rejection. */
export const denied = (
  call: Items.FunctionCall,
  reason?: string,
): Items.FunctionCallOutput => rejected(call, "denied", reason)

/** Implicit non-answer (follow-up, inactivity, abort). */
export const cancelled = (
  call: Items.FunctionCall,
  reason?: string,
): Items.FunctionCallOutput => rejected(call, "cancelled", reason)
