/**
 * Build the same loop you'd run anywhere else, then define tiny local
 * projections over its output stream to get the wire format you need:
 * Server-Sent Events for the browser, JSONL for everything else.
 *
 *   conversation
 *     .pipe(Stream.filterMap(toSSE))     ─→ Stream<SSE.Event>
 *     .pipe(Stream.filterMap(toJSONL))   ─→ Stream<string>
 *
 * The projections are intentionally recipe-local because they encode product
 * policy: this version forwards text deltas and completion, and drops
 * reasoning / tool-call internals.
 *
 * `index.ts` exports the building blocks; the runner lives in `run.ts`.
 */
import { Effect, Result, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import type * as SSE from "@effect-uai/core/SSE"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Local transport projections
// ---------------------------------------------------------------------------

const finalText = (turn: Turn.Turn): string => Turn.assistantText(turn)

export const toSSE = (event: Turn.TurnEvent): Result.Result<SSE.Event, void> => {
  if (event.type === "text_delta") {
    return Result.succeed({ event: "text", data: JSON.stringify({ text: event.text }) })
  }
  if (event.type === "turn_complete") {
    return Result.succeed({
      event: "done",
      data: JSON.stringify({
        stop_reason: event.turn.stop_reason,
        text: finalText(event.turn),
        usage: event.turn.usage,
      }),
    })
  }
  return Result.failVoid
}

export const toJSONL = (event: Turn.TurnEvent): Result.Result<string, void> => {
  if (event.type === "text_delta") {
    return Result.succeed(JSON.stringify({ type: "text", text: event.text }) + "\n")
  }
  if (event.type === "turn_complete") {
    return Result.succeed(
      JSON.stringify({
        type: "done",
        stop_reason: event.turn.stop_reason,
        text: finalText(event.turn),
        usage: event.turn.usage,
      }) + "\n",
    )
  }
  return Result.failVoid
}

export const asSSE: <E, R>(
  self: Stream.Stream<Turn.TurnEvent, E, R>,
) => Stream.Stream<SSE.Event, E, R> = Stream.filterMap(toSSE)

export const asJSONL: <E, R>(
  self: Stream.Stream<Turn.TurnEvent, E, R>,
) => Stream.Stream<string, E, R> = Stream.filterMap(toJSONL)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.Item>
}

export const initial: State = {
  history: [Items.userText("Tell me, in one sentence, why Lisbon is worth visiting.")],
}

// ---------------------------------------------------------------------------
// The loop. No tools, no fancy state - just a single streamed turn so the
// recipe stays focused on the transport layer.
// ---------------------------------------------------------------------------

export const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const lm = yield* LanguageModel
      return lm
        .streamTurn({ history: state.history, model: "gpt-5.4-mini" })
        .pipe(onTurnComplete(() => Effect.sync(() => stop)))
    }),
  ),
)
