/**
 * Multi-model compare: send the same question to OpenAI, Google, and
 * Anthropic concurrently, and stream their tagged deltas as they arrive.
 *
 * Each member is a `LanguageModelService`; their delta streams are tagged
 * with the member's name and merged via `Stream.mergeAll` so the consumer
 * sees a live, interleaved transcript. A failure in one member surfaces as
 * an `error` event on the merged stream and does not affect the other two.
 *
 * Run with:
 *   OPENAI_API_KEY=... GOOGLE_API_KEY=... ANTHROPIC_API_KEY=... \
 *     pnpm tsx recipes/multi-model-compare/index.ts
 */
import {
  Array as Arr,
  Config,
  Effect,
  Layer,
  Logger,
  Match,
  References,
  Stream,
  pipe,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import { matchType } from "@effect-uai/core/Match"
import * as Turn from "@effect-uai/core/Turn"
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { type Member, council } from "./council.js"

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const QUESTION = "In one short sentence, what's the most underrated programming language and why?"

const initialHistory: ReadonlyArray<Items.Item> = [Items.userText(QUESTION)]

const finalText = (turn: Turn.Turn): string =>
  pipe(
    Turn.assistantMessages(turn),
    Arr.flatMap((m) => m.content),
    Arr.filter(Items.isOutputText),
    Arr.map((c) => c.text),
  ).join("")

const program = Effect.gen(function* () {
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

  yield* Effect.logInfo("question", { question: QUESTION })

  yield* Stream.runForEach(council(members, initialHistory), (event) =>
    Match.value(event).pipe(
      matchType("delta", ({ member, delta }) =>
        Match.value(delta).pipe(
          matchType("text_delta", ({ text }) => Effect.logDebug(`${member} | ${text}`)),
          matchType("turn_complete", ({ turn }) =>
            Effect.logInfo(`${member} verdict`, {
              stop_reason: turn.stop_reason,
              usage: turn.usage,
              answer: finalText(turn),
            }),
          ),
          Match.orElse(() => Effect.void),
        ),
      ),
      matchType("error", ({ member, error }) => Effect.logWarning(`${member} failed`, { error })),
      Match.exhaustive,
    ),
  )
})

const mainLayer = Layer.mergeAll(FetchHttpClient.layer, Logger.layer([Logger.consolePretty()]))

Effect.runPromise(
  program.pipe(Effect.provide(mainLayer), Effect.provideService(References.MinimumLogLevel, "Info")),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
