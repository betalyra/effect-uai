/**
 * Model council: send the same question to OpenAI, Google, and Anthropic
 * concurrently; once each candidate finishes, every other model judges its
 * answer (no self-judging); once all scores are in, stream the winner.
 *
 * The whole pipeline is non-blocking: candidate deltas stream live, judge
 * calls fire as soon as their subject completes, and the winner is emitted
 * the moment the last score lands.
 *
 * Three providers at once, each holding a live service rather than a Layer,
 * so they are built here rather than through `_shared/model.ts`. `--question`
 * asks something else.
 */
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import * as Items from "@effect-uai/core/Items"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { Config, Effect, Match, Option, Stdio, Stream } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { type CouncilEvent, type Member, council } from "./recipe.js"

const DEFAULT_QUESTION =
  "Name a piece of conventional life wisdom you believe is wrong. Defend your pick in 3 sentences."

const logEvent = (event: CouncilEvent): Effect.Effect<void> =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      candidate_delta: ({ member, delta }) =>
        delta._tag === "TextDelta" ? Effect.logDebug(`${member} | ${delta.text}`) : Effect.void,
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

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const question = Option.getOrElse(
    flagValue("question", yield* stdio.args),
    () => DEFAULT_QUESTION,
  )
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

  yield* Effect.logInfo("question", { question })

  yield* Stream.runForEach(council(members, [Items.userText(question)]), logEvent)
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
