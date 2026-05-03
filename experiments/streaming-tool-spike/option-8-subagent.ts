/**
 * Sub-agent recipe spike using option 8.
 *
 * The killer use case for streaming tools: a tool whose `run` returns
 * a `Stream<TurnEvent>` from an inner agent. The reducer folds the
 * inner agent's `text_delta` events into a structured final answer.
 * The outer loop's recipe body uses plain `nextAfter`.
 *
 * What this file shows:
 *
 *   - The `ask_subagent` tool defined as a `Tool.streaming`.
 *   - The outer loop body that uses `executeAllSafe` and threads
 *     events through to the consumer.
 *
 * What this file deliberately does NOT include: a real inner-agent
 * implementation (would run another `loop` against a sub-LanguageModel
 * layer) or a fake one. The `runInner` parameter is supplied at the
 * call site - tests inject a mocked inner stream; a real recipe would
 * pass an actual sub-loop.
 */
import { Effect, Schema, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Turn from "@effect-uai/core/Turn"
import {
  type ToolEvent,
  executeAllSafe,
  nextStateFrom,
  streaming,
} from "./option-8-always-stream.js"

// ---------------------------------------------------------------------------
// Sub-agent tool.
//
// `run` is parametrized over a `runInner` function so callers can supply
// either a mocked stream (tests) or a real inner-loop stream (production).
// `step` accumulates text_delta payloads into the final answer string;
// the outer model sees the structured `SubAgentOutput`, not the raw deltas.
// ---------------------------------------------------------------------------

const SubAgentInput = Schema.Struct({ question: Schema.String })

export interface SubAgentOutput {
  readonly answer: string
}

export const makeSubAgent = (
  runInner: (question: string) => Stream.Stream<Turn.TurnEvent>,
) =>
  streaming({
    name: "ask_subagent",
    description: "Ask a specialist sub-agent for help with a hard question.",
    inputSchema: Tool.fromEffectSchema(SubAgentInput),
    run: ({ question }): Stream.Stream<Turn.TurnEvent> => runInner(question),
    finalize: (events): SubAgentOutput => ({
      answer: events
        .filter(
          (e): e is Extract<Turn.TurnEvent, { type: "text_delta" }> =>
            e.type === "text_delta",
        )
        .map((e) => e.text)
        .join(""),
    }),
    strict: true,
  })

// ---------------------------------------------------------------------------
// Outer loop state.
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.Item>
}

// ---------------------------------------------------------------------------
// Outer recipe body. `executeAllSafe` returns a real-time `Stream<ToolEvent>`;
// `nextStateFrom` drains it to the consumer in real-time, taps Outputs into
// an internal Ref, and at end-of-stream emits `Loop.next(build(outputs))`.
// The recipe never sees a Ref or runCollect.
// ---------------------------------------------------------------------------

export const buildConversation = (
  initial: State,
  runInnerAgent: (question: string) => Stream.Stream<Turn.TurnEvent>,
) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm
          .streamTurn({ history: state.history, model: "mock", tools: [] })
          .pipe(
            streamUntilComplete<State, ToolEvent>((turn) =>
              Effect.sync(() => {
                const next = Turn.cursor(state, turn)
                const calls = Turn.functionCalls(turn)
                if (calls.length === 0) return stop

                const events = executeAllSafe([makeSubAgent(runInnerAgent)], calls)
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
