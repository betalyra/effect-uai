/**
 * History consistency. Providers reject a request when a `function_call` has no
 * matching `function_call_output`; flows that can be interrupted, restarted or
 * branched (approvals, aborts, persisted checkpoints) close orphans with these
 * before the next model call.
 */
import { Effect, type Schema } from "effect"
import {
  type HistoryItem,
  isToolCall,
  isToolCallOutput,
  type ToolCall,
  type ToolCallOutput,
} from "../domain/Items.js"
import * as ToolOutput from "./ToolOutput.js"

/** Every `function_call` in `history` without a `function_call_output` (by `call_id`). */
export const findUnansweredCalls = (
  history: ReadonlyArray<HistoryItem>,
): ReadonlyArray<ToolCall> => {
  const answered = new Set(history.filter(isToolCallOutput).map((o) => o.call_id))
  return history.filter(isToolCall).filter((c) => !answered.has(c.call_id))
}

export const isReconciled = (history: ReadonlyArray<HistoryItem>): boolean =>
  findUnansweredCalls(history).length === 0

/**
 * A `Cancelled` output for every unanswered call, to append before the next
 * model call. For your own error, use `findUnansweredCalls` + `ToolOutput.failure`.
 */
export const cancelAllPending = (
  history: ReadonlyArray<HistoryItem>,
  reason = "The call was cancelled before it ran.",
): Effect.Effect<ReadonlyArray<ToolCallOutput>, Schema.SchemaError> =>
  Effect.forEach(findUnansweredCalls(history), (call) =>
    ToolOutput.failure(call, ToolOutput.Cancelled, new ToolOutput.Cancelled({ message: reason })),
  )
