/**
 * Library: history-consistency primitives. Useful even WITHOUT HITL.
 *
 * Every provider rejects a new request if any prior `function_call` lacks
 * a matching `function_call_output` (the strictness invariant - see the
 * provider survey doc). Multi-turn flows that can be interrupted,
 * restarted, or branched (HITL, mid-stream abort, persisted checkpoints,
 * stateless HTTP servers) need to detect orphans and synthesize closing
 * outputs before submitting.
 *
 * These are NOT magic. The recipe author calls them at known transition
 * points - typically right before the next provider request.
 */
import {
  type FunctionCall,
  type FunctionCallOutput,
  type Item,
  isFunctionCall,
  isFunctionCallOutput,
} from "@effect-uai/core/Items"
import { cancelled } from "./Outcome.js"

/**
 * Return every `function_call` in `history` that does not have a matching
 * `function_call_output` later in `history` (correlated by `call_id`).
 * Result preserves source order. Empty result = history is provider-
 * submittable from this invariant's perspective.
 */
export const findUnansweredCalls = (
  history: ReadonlyArray<Item>,
): ReadonlyArray<FunctionCall> => {
  const answered = new Set(history.filter(isFunctionCallOutput).map((o) => o.call_id))
  return history.filter(isFunctionCall).filter((c) => !answered.has(c.call_id))
}

/** Cheap predicate: is this history submittable to a provider? */
export const isReconciled = (history: ReadonlyArray<Item>): boolean =>
  findUnansweredCalls(history).length === 0

/**
 * Synthesize cancellation outputs for every unanswered call. The caller
 * appends them to history before submitting:
 *
 * ```ts
 * const fixed = [...history, ...cancelAllPending(history, "User moved on.")]
 * ```
 *
 * Use when: a new user message arrives mid-approval; an approval timer
 * fires; a persisted checkpoint contains orphans (crash recovery); a
 * stateless HTTP server reconstructs context from a stale store.
 */
export const cancelAllPending = (
  history: ReadonlyArray<Item>,
  reason?: string,
): ReadonlyArray<FunctionCallOutput> =>
  findUnansweredCalls(history).map((call) => cancelled(call, reason))
