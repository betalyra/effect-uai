/**
 * Application code: WebSocket / persistent-connection HITL recipe.
 *
 * Verdicts arrive over time on a shared `Queue<Verdict>`. The recipe:
 *
 *   1. Builds a `Resolver` from the queue (`fromVerdictQueue`) plus an
 *      announcement stream of `ApprovalRequested` events.
 *   2. Hands both to `executeWithResolver` (merged so announcements lead).
 *   3. Threads outputs into next-state via `nextStateFrom`.
 *
 * Compare against the previous spike's `executeWithApproval`-based
 * recipe: same number of lines, but the executor primitive is now
 * decoupled from the transport. Swap `fromVerdictQueue` for
 * `fromApprovalMap` (next file) and the body of the recipe is
 * basically unchanged.
 */
import { Effect, Queue, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import {
  type ToolEvent,
  type Verdict,
  executeWithResolver,
  fromVerdictQueue,
  nextStateFrom,
  toDescriptors,
} from "../lib/index.js"
import { isSensitive } from "./approval.js"
import { allTools } from "./tools.js"

export interface State {
  readonly history: ReadonlyArray<Items.Item>
}

export const buildConversation = (verdicts: Queue.Queue<Verdict>, initial: State) =>
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
              Effect.gen(function* () {
                const next = Turn.cursor(state, turn)
                const calls = Turn.functionCalls(turn)
                if (calls.length === 0) return stop

                const { resolve, announce } = yield* fromVerdictQueue(
                  isSensitive,
                  verdicts,
                )(calls)

                const events = Stream.merge(
                  announce,
                  executeWithResolver(allTools, calls, resolve),
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
