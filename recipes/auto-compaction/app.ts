/**
 * Composition for the auto-compaction recipe: `--model` for the normal turns,
 * `--summary-model` for the throwaway summaries, and a `main` that logs each
 * completed turn with its token counts, which is where compaction shows up.
 */
import { Effect, Match, Option, Stdio, Stream } from "effect"
import * as Turn from "@effect-uai/core/Turn"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { DEFAULT_MODEL, DEFAULT_SUMMARY_MODEL, conversation } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => DEFAULT_MODEL),
    "openai",
  )
  const summary = Option.getOrElse(flagValue("summary-model", argv), () => DEFAULT_SUMMARY_MODEL)

  yield* Stream.runForEach(conversation(spec.model, summary), (event) =>
    Match.value(event).pipe(
      Match.discriminators("_tag")({
        TurnComplete: ({ turn }) =>
          Effect.logInfo("turn complete", {
            stop_reason: turn.stop_reason,
            input_tokens: turn.usage.input_tokens,
            output_tokens: turn.usage.output_tokens,
            assistant: Turn.assistantTexts(turn).join(" "),
          }),
      }),
      Match.orElse(() => Effect.void),
    ),
  ).pipe(Effect.provide(languageModelLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
