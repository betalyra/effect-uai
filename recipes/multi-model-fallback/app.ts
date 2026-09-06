/**
 * Composition for the multi-model-fallback recipe. The tier list is the
 * demo's, not the loop's: `recipe.ts` takes any ordered array of services and
 * walks it on a retryable failure.
 *
 * The primary tier points at a deliberately unreachable host, so the
 * fallback fires on every run and you can see it in the logs. `--base-url`
 * overrides it if you want the primary to actually answer.
 */
import { Config, Effect, Match, Option, Stdio, Stream } from "effect"
import * as Turn from "@effect-uai/core/Turn"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { type Tier, conversation } from "./recipe.js"

const UNREACHABLE = "https://invalid-host.example.invalid/v1"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const baseUrl = Option.getOrElse(flagValue("base-url", argv), () => UNREACHABLE)

  const openai = yield* makeResponses({
    apiKey: yield* Config.redacted("OPENAI_API_KEY"),
    baseUrl,
  })
  const google = yield* makeGemini({ apiKey: yield* Config.redacted("GOOGLE_API_KEY") })

  const tiers: ReadonlyArray<Tier> = [
    { name: "openai/gpt-5.4-mini", model: "gpt-5.4-mini", service: openai },
    { name: "google/gemini-3-flash-preview", model: "gemini-3-flash-preview", service: google },
  ]

  yield* Stream.runForEach(conversation(tiers), (event) =>
    Match.value(event).pipe(
      Match.when({ _tag: "TurnComplete" }, ({ turn }) =>
        Effect.logInfo("turn complete", {
          stop_reason: turn.stop_reason,
          assistant: Turn.assistantTexts(turn).join(" "),
        }),
      ),
      Match.orElse(() => Effect.void),
    ),
  )
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
