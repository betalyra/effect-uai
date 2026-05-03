/**
 * `findUnansweredCalls` and friends - the reconciliation primitives that
 * are useful even *without* HITL. Every provider rejects a new user turn
 * if any prior `function_call` lacks a matching `function_call_output`,
 * so multi-turn flows that can be interrupted, restarted, or branched
 * (HITL, mid-stream abort, persisted checkpoints) need a way to find
 * orphans before the next provider call.
 *
 * Spike location only. If accepted:
 *   - `findUnansweredCalls` lands in `Items.ts`.
 *   - `cancelAllPending` lands in `Toolkit.ts` next to `cancelled`.
 */
import {
  type FunctionCall,
  type FunctionCallOutput,
  type Item,
  isFunctionCall,
  isFunctionCallOutput,
} from "@effect-uai/core/Items"
import { cancelled } from "./tool-outcome.js"

/**
 * Return every `function_call` in `history` that does not have a matching
 * `function_call_output` later in `history` (correlated by `call_id`).
 *
 * The result preserves source order. Empty array means the history is
 * provider-submittable from this invariant's perspective.
 */
export const findUnansweredCalls = (
  history: ReadonlyArray<Item>,
): ReadonlyArray<FunctionCall> => {
  const answered = new Set(
    history.filter(isFunctionCallOutput).map((o) => o.call_id),
  )
  return history.filter(isFunctionCall).filter((c) => !answered.has(c.call_id))
}

/** Cheap predicate: is this history submittable to a provider? */
export const isReconciled = (history: ReadonlyArray<Item>): boolean =>
  findUnansweredCalls(history).length === 0

/**
 * Synthesize cancellation outputs for every unanswered call in `history`.
 * The caller appends them to history before submitting:
 *
 * ```ts
 * const fixed = [...history, ...cancelAllPending(history, "User moved on.")]
 * ```
 *
 * Use this when:
 *   - A new user message arrives while approvals were pending.
 *   - An approval timer fires.
 *   - A persisted checkpoint contains orphan calls (e.g. crash recovery).
 */
export const cancelAllPending = (
  history: ReadonlyArray<Item>,
  reason?: string,
): ReadonlyArray<FunctionCallOutput> =>
  findUnansweredCalls(history).map((call) => cancelled(call, reason))
