/**
 * Try the primary model; on `RateLimited` or `Unavailable`, advance to the
 * next tier in the list and retry the same history. Other errors propagate.
 *
 * The demo wires OpenAI (`gpt-5.4-mini`) as the primary tier with a
 * deliberately broken `baseUrl` so the first request resolves to
 * `Unavailable`, then falls back to Gemini (`gemini-3-flash-preview`)
 * which runs against the real endpoint and produces the answer.
 *
 * Run with:
 *   OPENAI_API_KEY=sk-... GOOGLE_API_KEY=... pnpm tsx recipes/multi-model-fallback/index.ts
 */
import * as Items from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import { loop, next, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import { Effect, Stream, pipe } from "effect"

// ---------------------------------------------------------------------------
// State and types
// ---------------------------------------------------------------------------

export interface Tier {
  readonly name: string
  readonly model: string
  readonly service: LanguageModelService
}

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly tier: number
}

const initial: State = {
  history: [Items.userText("In one sentence, what is the capital of Portugal?")],
  tier: 0,
}

// ---------------------------------------------------------------------------
// The loop - try a tier; on retryable failures, advance and try the next.
// First successful turn ends the loop.
// ---------------------------------------------------------------------------

export const conversation = (tiers: ReadonlyArray<Tier>) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const tier = tiers[state.tier]
        if (tier === undefined) {
          yield* Effect.logError("all tiers exhausted - no provider succeeded")
          return stop()
        }

        yield* Effect.logInfo(`trying ${tier.name}`)

        const advanceTier = (reason: string) =>
          Effect.logWarning(`${tier.name}: ${reason} - falling back`).pipe(
            Effect.as(next({ ...state, tier: state.tier + 1 })),
          )

        return tier.service.streamTurn({ history: state.history, model: tier.model }).pipe(
          // Success path: first complete turn ends the whole loop.
          onTurnComplete(() => Effect.sync(stop)),
          Stream.catchTag("RateLimited", () => Stream.unwrap(advanceTier("rate-limited"))),
          Stream.catchTag("Unavailable", () => Stream.unwrap(advanceTier("unavailable"))),
        )
      }),
    ),
  )
