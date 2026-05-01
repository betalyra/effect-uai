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
import { Config, Effect, Layer, Logger, Match, References, Stream, pipe } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import { loop, nextAfter, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import { make as makeGemini } from "@effect-uai/google"
import { make as makeResponses } from "@effect-uai/responses"

// ---------------------------------------------------------------------------
// State and types
// ---------------------------------------------------------------------------

interface Tier {
  readonly name: string
  readonly model: string
  readonly service: LanguageModelService
}

interface State {
  readonly history: ReadonlyArray<Items.Item>
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

const conversation = (tiers: ReadonlyArray<Tier>) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const tier = tiers[state.tier]
        if (tier === undefined) {
          yield* Effect.logError("all tiers exhausted - no provider succeeded")
          return stop
        }

        yield* Effect.logInfo(`trying ${tier.name}`)

        const advanceTier = (reason: string) =>
          Effect.logWarning(`${tier.name}: ${reason} - falling back`).pipe(
            Effect.as(nextAfter(Stream.empty, { ...state, tier: state.tier + 1 })),
          )

        return tier.service.streamTurn({ history: state.history, model: tier.model }).pipe(
          // Success path: first complete turn ends the whole loop.
          streamUntilComplete(() => Effect.sync(() => stop)),
          Stream.catchTag("RateLimited", () => Stream.unwrap(advanceTier("rate-limited"))),
          Stream.catchTag("Unavailable", () => Stream.unwrap(advanceTier("unavailable"))),
        )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const openaiKey = yield* Config.redacted("OPENAI_API_KEY")
  const googleKey = yield* Config.redacted("GOOGLE_API_KEY")

  // Primary tier - deliberately broken baseUrl forces an `Unavailable` so
  // we can see the fallback fire in the logs.
  const openai = yield* makeResponses({
    apiKey: openaiKey,
    baseUrl: "https://invalid-host.example.invalid/v1",
  })
  const google = yield* makeGemini({ apiKey: googleKey })

  const tiers: ReadonlyArray<Tier> = [
    { name: "openai/gpt-5.4-mini", model: "gpt-5.4-mini", service: openai },
    {
      name: "google/gemini-3-flash-preview",
      model: "gemini-3-flash-preview",
      service: google,
    },
  ]

  yield* Stream.runForEach(conversation(tiers), (event) =>
    Match.value(event).pipe(
      Match.when({ type: "turn_complete" }, ({ turn }) =>
        Effect.logInfo("turn complete", {
          stop_reason: turn.stop_reason,
          assistant: Turn.assistantMessages(turn)
            .flatMap((m) => m.content)
            .filter(Items.isOutputText)
            .map((c) => c.text)
            .join(" "),
        }),
      ),
      Match.orElse(() => Effect.void),
    ),
  )
})

const runtime = Layer.mergeAll(FetchHttpClient.layer, Logger.layer([Logger.consolePretty()]))

Effect.runPromise(
  program.pipe(Effect.provide(runtime), Effect.provideService(References.MinimumLogLevel, "Info")),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
