/**
 * A long-lived agentic loop driven by a user-message queue. Between
 * turns, the loop checks the queue for new input; messages that arrive
 * close together are coalesced into one batch via a small "settle"
 * debounce (the window resets every time a new message lands).
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
 * `index.ts` exports the building blocks; the runner lives in `run.ts`.
 */
import { Duration, Effect, Queue, Stream, pipe } from "effect";
import * as Items from "@effect-uai/core/Items";
import { LanguageModel } from "@effect-uai/core/LanguageModel";
import { loop, nextAfter, onTurnComplete } from "@effect-uai/core/Loop";
import * as Tool from "@effect-uai/core/Tool";
import * as Toolkit from "@effect-uai/core/Toolkit";
import * as Turn from "@effect-uai/core/Turn";

// ---------------------------------------------------------------------------
// drainBurst - a Stream-based debouncer. Block on the first message,
// then keep collecting while the next message arrives within `settle`
// of the previous one. The window resets on every arrival, so a burst
// of typing flows together while a single message + long silence ends
// the burst right away.
//
// Modeled as `Stream.unfold` over a seed that flips after the first
// message: subsequent steps race the next take against the settle
// window. `runCollect` materializes the burst as an array.
// ---------------------------------------------------------------------------

export const drainBurst = <A>(
  queue: Queue.Queue<A>,
  settle: Duration.Input,
): Effect.Effect<ReadonlyArray<A>> =>
  Stream.unfold(false, (started) =>
    started
      ? Effect.race(
          Queue.take(queue).pipe(Effect.map((m) => [m, true] as const)),
          Effect.sleep(settle).pipe(Effect.as(undefined)),
        )
      : Queue.take(queue).pipe(Effect.map((m) => [m, true] as const)),
  ).pipe(Stream.runCollect);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.Item>;
}

export const initial: State = { history: [] };

// True when the model owes us a response (last item is a tool output)
// or there's nothing yet so we're waiting on the user. False when the
// previous turn ended cleanly with an assistant message - i.e. the
// loop should pause for the next user message.
const needsUserInput = (state: State): boolean => {
  const last = state.history[state.history.length - 1];
  if (last === undefined) return true;
  return last.type === "message" && last.role === "assistant";
};

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export const conversation = (
  queue: Queue.Queue<string>,
  tools: ReadonlyArray<Tool.AnyKindTool>,
  settle: Duration.Input = "150 millis",
) => {
  const descriptors = Tool.toDescriptors(tools);

  return pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        // Drain any pending user input before each new request, but
        // skip the wait when the model is mid-task (tool outputs hanging).
        const incoming = needsUserInput(state)
          ? yield* drainBurst(queue, settle)
          : [];
        const history = [...state.history, ...incoming.map(Items.userText)];

        const lm = yield* LanguageModel;
        return lm
          .streamTurn({ history, model: "gpt-5.4-mini", tools: descriptors })
          .pipe(
            onTurnComplete((turn) =>
              Effect.sync(() => {
                const calls = Turn.functionCalls(turn);

                // No tool calls - the assistant is done. Continue with
                // the appended turn; the next iteration will block on
                // the queue for the next user message.
                if (calls.length === 0) {
                  return nextAfter(
                    Stream.empty,
                    Turn.appendTurn({ history }, turn),
                  );
                }

                // Tool calls: stream tool events to the consumer and
                // emit one `Loop.next` carrying the appended turn. The
                // next iteration runs the model again to incorporate
                // the outputs, skipping the queue check.
                return Toolkit.executeAll(tools, calls).pipe(
                  Toolkit.continueWith(Toolkit.appendToolResults({ history }, turn)),
                );
              }),
            ),
          );
      }),
    ),
  );
};
