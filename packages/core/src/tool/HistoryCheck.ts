/**
 * History-consistency primitives. Useful even WITHOUT HITL.
 *
 * Every provider rejects a new request if any prior `function_call` lacks
 * a matching `function_call_output`. Multi-turn flows that can be
 * interrupted, restarted, or branched (HITL, mid-stream abort, persisted
 * checkpoints, stateless HTTP servers) need to detect orphans and
 * synthesize closing outputs before submitting.
 *
 * Recipe author calls these at known transition points (right before the
 * next provider request). Not invoked from inside the loop.
 */
import {
  type ToolCall,
  type HistoryItem,
  isToolCall,
  isToolCallOutput,
} from "../domain/Items.js"
import { type ToolResult, cancelled } from "./ToolResult.js"

/**
 * Return every `function_call` in `history` that does not have a matching
 * `function_call_output` later in `history` (correlated by `call_id`).
 * Empty result = history is provider-submittable from this invariant.
 */
export const findUnansweredCalls = (
  history: ReadonlyArray<HistoryItem>,
): ReadonlyArray<ToolCall> => {
  const answered = new Set(history.filter(isToolCallOutput).map((o) => o.call_id))
  return history.filter(isToolCall).filter((c) => !answered.has(c.call_id))
}

/** Cheap predicate: is this history submittable to a provider? */
export const isReconciled = (history: ReadonlyArray<HistoryItem>): boolean =>
  findUnansweredCalls(history).length === 0

/**
 * Synthesize cancellation results for every unanswered call. Caller maps
 * via `toToolCallOutput` and appends to history before submitting.
 *
 * Use when: a new user message arrives mid-approval; an approval timer
 * fires; a persisted checkpoint contains orphans (crash recovery); a
 * stateless HTTP server reconstructed history from a stale checkpoint.
 */
export const cancelAllPending = (
  history: ReadonlyArray<HistoryItem>,
  reason?: string,
): ReadonlyArray<ToolResult> => findUnansweredCalls(history).map((call) => cancelled(call, reason))
