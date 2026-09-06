/**
 * Soft pause / resume of an in-flight agent loop using `Latch`. The body
 * waits on the latch before each iteration; closing it pauses the loop
 * (no new `streamTurn` is initiated, no HTTP connection held), opening it
 * resumes. State threads through the loop naturally, so resume picks up
 * exactly where pause left off - no checkpoint to write.
 *
 * The demo gates pause/resume on turn count via a shared `Ref` so the
 * pause lands at a known point regardless of how fast the model responds.
 *
 */
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, next, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import { Effect, Latch, Ref, pipe } from "effect"

// ---------------------------------------------------------------------------
// Demo configuration
// ---------------------------------------------------------------------------

const PROMPT_BANK = [
  "Tell me one short fact about Lisbon.",
  "Now Tokyo.",
  "Now Rio.",
  "Now Paris.",
  "Now Cairo.",
  "Now London.",
] as const

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly pendingPrompts: ReadonlyArray<string>
}

const initial: State = {
  history: [Items.userText(PROMPT_BANK[0])],
  pendingPrompts: PROMPT_BANK.slice(1),
}

const advance = (state: State, turn: Turn.Turn): State => ({
  history: [...state.history, ...turn.items],
  pendingPrompts: state.pendingPrompts,
})

// ---------------------------------------------------------------------------
// The loop - one `Latch.await` at the top is the entire pause mechanism.
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "gpt-5.4-mini"

export const conversation = (
  pauseLatch: Latch.Latch,
  turnsCompleted: Ref.Ref<number>,
  model = DEFAULT_MODEL,
) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        // Pause point: returns immediately if open, blocks if closed.
        yield* Latch.await(pauseLatch)

        const lm = yield* LanguageModel
        return lm
          .streamTurn({
            history: state.history,
            model,
          })
          .pipe(
            onTurnComplete((turn) =>
              Effect.gen(function* () {
                yield* Ref.update(turnsCompleted, (n) => n + 1)
                const nextState = advance(state, turn)
                if (nextState.pendingPrompts.length === 0) return stop()
                const [nextPrompt, ...rest] = nextState.pendingPrompts
                return next({
                  ...nextState,
                  history: [...nextState.history, Items.userText(nextPrompt!)],
                  pendingPrompts: rest,
                })
              }),
            ),
          )
      }),
    ),
  )
