/**
 * Application code: HTTP / request-shaped HITL recipe.
 *
 * The user's next message arrives as one HTTP request carrying any
 * approvals as a synchronous payload. No queue, no router fiber. If a
 * gated call has no entry in the map, `fromApprovalMap` synthesizes a
 * `cancelled` Output so history is well-formed before the next provider
 * request - matching the wire-protocol invariant from the strictness
 * doc (every `function_call` needs a matching output).
 *
 * The body is shorter than the WebSocket variant by one Stream.merge:
 * HTTP doesn't need an `ApprovalRequested` channel because the next user
 * message IS the approval response.
 */
import { Effect, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import {
  type ApprovalMapEntry,
  type ToolEvent,
  executeWithResolver,
  fromApprovalMap,
  nextStateFrom,
  toDescriptors,
} from "../lib/index.js"
import { isSensitive } from "./approval.js"
import { allTools } from "./tools.js"

export interface State {
  readonly history: ReadonlyArray<Items.Item>
}

/**
 * `approvals` is the verdict map bundled in the user's HTTP request.
 * One entry per call_id the user actually decided on. Missing entries
 * for gated calls are treated as cancellation.
 */
export const buildConversation = (
  approvals: ReadonlyMap<string, ApprovalMapEntry>,
  initial: State,
) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm
          .streamTurn({
            history: state.history,
            model: "mock",
            tools: toDescriptors(allTools),
          })
          .pipe(
            streamUntilComplete<State, ToolEvent>((turn) =>
              Effect.sync(() => {
                const next = Turn.cursor(state, turn)
                const calls = Turn.functionCalls(turn)
                if (calls.length === 0) return stop

                const events = executeWithResolver(
                  allTools,
                  calls,
                  fromApprovalMap(isSensitive, approvals),
                )

                return nextStateFrom(events, (outputs) => ({
                  ...next,
                  history: [...next.history, ...outputs],
                }))
              }),
            ),
          )
      }),
    ),
  )
