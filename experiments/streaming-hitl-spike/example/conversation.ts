/**
 * Application code: the full HITL + streaming recipe.
 *
 * The whole conversation builder is ~25 lines of body. The split between
 * library and application code:
 *
 *   - Library:    `executeWithApproval` (real-time stream + approval gating)
 *                 `nextStateFrom`        (drain stream, build next state)
 *
 *   - Application: the three tools, the approval predicate, the loop
 *                  scaffolding (`loop` + `streamUntilComplete`), and how
 *                  next-state is composed from outputs.
 *
 * Compare against the buffered partition spike's `hitl-example.ts` -
 * that recipe needed an `announce` substream concatenated before the
 * `executePartitioned` continuation, plus `nextAfter` and a separate
 * `Stream.fromIterable(outputs)` pass. Here it's just: get a stream,
 * thread state with `nextStateFrom`. The library handles announcement,
 * gating, and real-time intermediates.
 */
import { Effect, Queue, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import {
  type ToolEvent,
  type Verdict,
  executeWithApproval,
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
              Effect.sync(() => {
                const next = Turn.cursor(state, turn)
                const calls = Turn.functionCalls(turn)
                if (calls.length === 0) return stop

                const events = executeWithApproval(allTools, calls, {
                  requiresApproval: isSensitive,
                  verdicts,
                })

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
