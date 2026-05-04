/**
 * Build the same loop you'd run anywhere else, then `filterMap` a tiny
 * function over its output stream to get the wire format you need:
 * Server-Sent Events for the browser, JSONL for everything else.
 *
 *   conversation
 *     .pipe(Stream.filterMap(toSSE))     ─→ Stream<SSE.Event>
 *     .pipe(Stream.filterMap(toJSONL))   ─→ Stream<string>
 *
 * `toSSE` and `toJSONL` ship in `@effect-uai/core/Turn`; this recipe is
 * just a basic loop that demonstrates calling them.
 *
 * `index.ts` exports the building blocks; the runner lives in `run.ts`.
 */
import { Effect, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"

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
        .pipe(streamUntilComplete<State, never>(() => Effect.sync(() => stop)))
    }),
  ),
)
