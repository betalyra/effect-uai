/**
 * Model council: send the same question to OpenAI, Google, and Anthropic
 * concurrently; once each candidate finishes, every other model judges its
 * answer (no self-judging); once all scores are in, stream the winner.
 *
 * The whole pipeline is non-blocking: candidate deltas stream live, judge
 * calls fire as soon as their subject completes, and the winner is emitted
 * the moment the last score lands.
 *
 * Run with:
 *   OPENAI_API_KEY=... GOOGLE_API_KEY=... ANTHROPIC_API_KEY=... \
 *     pnpm tsx recipes/model-council/index.ts
 */
import { Config, Effect, Layer, Logger, Match, References, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { type CouncilEvent, type Member, council } from "./council.js"

const QUESTION =
  "Name a piece of conventional life wisdom you believe is wrong. Defend your pick in 3 sentences."

const initialHistory: ReadonlyArray<Items.Item> = [Items.userText(QUESTION)]

const logEvent = (event: CouncilEvent): Effect.Effect<void> =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      candidate_delta: ({ member, delta }) =>
        delta.type === "text_delta" ? Effect.logDebug(`${member} | ${delta.text}`) : Effect.void,
      candidate_complete: ({ member, answer }) =>
        Effect.logInfo(`candidate complete: ${member}`, { answer }),
      score: ({ judge, subject, score, rationale }) =>
        Effect.logInfo(`score ${judge} -> ${subject}: ${score}`, { rationale }),
      winner: ({ member, answer, averageScore }) =>
        Effect.logInfo(`WINNER: ${member} (avg ${averageScore.toFixed(2)})`, {
          winner: member,
          averageScore,
          answer,
        }),
      error: ({ member, phase, error }) =>
        Effect.logWarning(`${member} failed in ${phase}`, { error }),
    }),
  )

const program = Effect.gen(function* () {
  const openaiKey = yield* Config.redacted("OPENAI_API_KEY")
  const googleKey = yield* Config.redacted("GOOGLE_API_KEY")
  const anthropicKey = yield* Config.redacted("ANTHROPIC_API_KEY")

  const openai = yield* makeResponses({ apiKey: openaiKey })
  const google = yield* makeGemini({ apiKey: googleKey })
  const anthropic = yield* makeAnthropic({ apiKey: anthropicKey, defaultMaxTokens: 512 })

  const members: ReadonlyArray<Member> = [
    { name: "openai/gpt-5.4-mini", model: "gpt-5.4-mini", service: openai },
    {
      name: "google/gemini-3-flash-preview",
      model: "gemini-3-flash-preview",
      service: google,
    },
    {
      name: "anthropic/claude-sonnet-4-6",
      model: "claude-sonnet-4-6",
      service: anthropic,
    },
  ]

  yield* Effect.logInfo("question", { question: QUESTION })

  yield* Stream.runForEach(council(members, initialHistory), logEvent)
})

const mainLayer = Layer.mergeAll(FetchHttpClient.layer, Logger.layer([Logger.consolePretty()]))

Effect.runPromise(
  program.pipe(Effect.provide(mainLayer), Effect.provideService(References.MinimumLogLevel, "Info")),
).catch((err) => {
  Effect.runSync(Effect.logError("recipe failed", { err }))
  process.exit(1)
})
