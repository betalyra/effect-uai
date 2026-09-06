/**
 * Multi-model compare: send the same question to OpenAI, Google, and
 * Anthropic concurrently, and stream their tagged deltas as they arrive.
 *
 * Each member is a `LanguageModelService`; their delta streams are tagged
 * with the member's name and merged via `Stream.mergeAll` so the consumer
 * sees a live, interleaved transcript. A failure in one member surfaces as
 * an `error` event on the merged stream and does not affect the other two.
 *
 * Three providers at once, each holding a live service rather than a Layer,
 * so they are built here rather than through `_shared/model.ts`. `--question`
 * asks something else.
 */
import { Config, Effect, Match, Option, Stdio, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { type Member, council } from "./recipe.js"

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const DEFAULT_QUESTION =
  "In one short sentence, what's the most underrated programming language and why?"

const finalText = (turn: Turn.Turn): string => Turn.assistantText(turn)

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
  const anthropic = yield* makeAnthropic({ apiKey: anthropicKey, defaultMaxTokens: 256 })

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

  yield* Stream.runForEach(council(members, [Items.userText(question)]), (event) =>
    Match.value(event).pipe(
      Match.discriminatorsExhaustive("type")({
        delta: ({ member, delta }) =>
          Match.value(delta).pipe(
            Match.discriminators("_tag")({
              TextDelta: ({ text }) => Effect.logDebug(`${member} | ${text}`),
              TurnComplete: ({ turn }) =>
                Effect.logInfo(`${member} verdict`, {
                  stop_reason: turn.stop_reason,
                  usage: turn.usage,
                  answer: finalText(turn),
                }),
            }),
            Match.orElse(() => Effect.void),
          ),
        error: ({ member, error }) => Effect.logWarning(`${member} failed`, { error }),
      }),
    ),
  )
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
