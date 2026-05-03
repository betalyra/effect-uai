/**
 * Application code: WebSocket HITL recipe with an authz check layered on
 * top.
 *
 * The point: `withPermissions` is a plain Resolver→Resolver wrapper.
 * Stack as many policy layers as you want (`withFallback`, custom
 * combinators, etc.). The executor primitive is unchanged; the recipe
 * shape is unchanged. Only the resolver gets richer.
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
  toFunctionCallOutput,
  withPermissions,
} from "../lib/index.js"
import { isSensitive } from "./approval.js"
import { allTools } from "./tools.js"

export interface State {
  readonly history: ReadonlyArray<Items.Item>
}

export const buildConversation = (
  verdicts: Queue.Queue<Verdict>,
  initial: State,
  // application's authz hook - typically wraps a session lookup, RBAC check, etc.
  canApprove: (call: Items.FunctionCall) => Effect.Effect<boolean>,
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
              Effect.gen(function* () {
                const next = Turn.cursor(state, turn)
                const calls = Turn.functionCalls(turn)
                if (calls.length === 0) return stop

                const { resolve, announce } = yield* fromVerdictQueue(
                  isSensitive,
                  verdicts,
                )(calls)

                // Stack: authz check first; if allowed, fall through to
                // the queue-based verdict resolver.
                const guarded = withPermissions(resolve, canApprove)

                const events = Stream.merge(
                  announce,
                  executeWithResolver(allTools, calls, guarded),
                )

                return nextStateFrom(events, (results) => ({
                  ...next,
                  history: [...next.history, ...results.map(toFunctionCallOutput)],
                }))
              }),
            ),
          )
      }),
    ),
  )
