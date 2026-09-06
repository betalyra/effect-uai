/**
 * Cancel an in-flight `streamTurn` cleanly via `Stream.interruptWhen`.
 * When the abort `Deferred` completes, the conversation stream ends, the
 * loop's outer scope closes, and Effect's structured concurrency tears
 * down the HTTP response - which signals `AbortController` on the
 * underlying `fetch`, closing the upstream connection.
 *
 * The recipe asks for a long answer, then triggers abort after 1 second.
 * Watch the partial text deltas arrive in the log before the stream
 * stops; no `TurnComplete` is emitted because the turn never finished.
 *
 */
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import { Effect, pipe } from "effect"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
}

const initial: State = {
  history: [
    Items.userText(
      "Write a long, detailed essay (around 500 words) about the history of the Portuguese azulejo tile.",
    ),
  ],
}

// ---------------------------------------------------------------------------
// The loop - a single turn that runs to completion, unless interrupted.
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "gpt-5.4-mini"

export const conversation = (model = DEFAULT_MODEL) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm
          .streamTurn({ history: state.history, model })
          .pipe(onTurnComplete(() => Effect.sync(stop)))
      }),
    ),
  )
