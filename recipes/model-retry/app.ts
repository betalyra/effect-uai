/**
 * Composition for the model-retry recipe: `--model provider:model` resolved
 * to a Layer by `_shared/model.ts`, and a `main` that drives the retrying
 * conversation from `recipe.ts` and logs each completed turn.
 */
import { Effect, Match, Option, Stdio, Stream } from "effect"
import * as Turn from "@effect-uai/core/Turn"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { conversation } from "./recipe.js"

const render = (model: string) =>
  Stream.runForEach(conversation(model), (event) =>
    Match.value(event).pipe(
      Match.discriminators("_tag")({
        TurnComplete: ({ turn }) =>
          Effect.logInfo("turn complete", {
            stop_reason: turn.stop_reason,
            assistant: Turn.assistantTexts(turn).join(" "),
          }),
      }),
      Match.orElse(() => Effect.void),
    ),
  )

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => "gpt-5.4-mini"),
    "openai",
  )
  yield* render(spec.model).pipe(Effect.provide(languageModelLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
