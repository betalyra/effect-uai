/**
 * A long-lived agentic loop driven by a user-message queue. Between
 * turns, the loop checks the queue for new input; messages that arrive
 * close together are coalesced into one batch by `Inbox.drainBurst`
 * (a "settle" debounce whose window resets every time a message lands).
 *
 * Lifecycle of one iteration:
 *
 *   1. Decide whether to wait for input. If the previous turn ended on
 *      tool outputs, the model still owes us a response - run a turn
 *      immediately. Otherwise, drain the queue (block on the first
 *      message, then collect the burst).
 *   2. Stream the turn. Forward deltas downstream.
 *   3. On `TurnComplete`: if the model called tools, execute them and
 *      append outputs (next iteration runs the model again, no queue
 *      check). If not, the next iteration will block on the queue.
 *
 * Termination is external: the runner forks the loop and interrupts
 * the fiber after a timeout (or on a stop signal). The loop itself
 * never decides to stop - that's a UI / lifetime concern.
 *
 * This file exports the building blocks; `app.ts` wires the provider.
 */
import { type Duration, Effect, type Queue, pipe } from "effect"
import { drainBurst } from "@effect-uai/core/Inbox"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, next, onTurnComplete } from "@effect-uai/core/Loop"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
}

export const initial: State = { history: [] }

// True when the model owes us a response (last item is a tool output)
// or there's nothing yet so we're waiting on the user. False when the
// previous turn ended cleanly with an assistant message - i.e. the
// loop should pause for the next user message.
const needsUserInput = (state: State): boolean => {
  const last = state.history[state.history.length - 1]
  if (last === undefined) return true
  return last.type === "message" && last.role === "assistant"
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export const conversation = (
  queue: Queue.Queue<string>,
  toolkit: Toolkit.Toolkit,
  settle: Duration.Input = "150 millis",
) => {
  return pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        // Drain any pending user input before each new request, but
        // skip the wait when the model is mid-task (tool outputs hanging).
        const incoming = needsUserInput(state) ? yield* drainBurst(queue, settle) : []
        const history = [...state.history, ...incoming.map(Items.userText)]

        const lm = yield* LanguageModel
        return lm.streamTurn({ history, model: "gpt-5.4-mini", tools: toolkit }).pipe(
          onTurnComplete((turn) =>
            Effect.sync(() => {
              const calls = Turn.getToolCalls(turn)

              // No tool calls - the assistant is done. Continue with
              // the appended turn; the next iteration will block on
              // the queue for the next user message.
              if (calls.length === 0) {
                return next(Turn.appendToHistory({ history }, turn))
              }

              // Tool calls: stream tool events to the consumer and
              // emit one `Loop.next` carrying the appended turn. The
              // next iteration runs the model again to incorporate
              // the outputs, skipping the queue check.
              return Toolkit.run(toolkit, calls).pipe(
                Toolkit.continueWithResults(Toolkit.appendToolResults({ history }, turn)),
              )
            }),
          ),
        )
      }),
    ),
  )
}
