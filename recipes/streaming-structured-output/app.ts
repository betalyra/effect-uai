/**
 * Composition for the streaming-structured-output recipe: `--model
 * provider:model` resolved to a Layer by `_shared/model.ts`. The recipe
 * decodes prompted JSONL one object at a time, so any provider works.
 */
import { Effect, Option, Stdio } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { streamRecipes } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => "gpt-5.4-mini"),
    "openai",
  )

  yield* Effect.logInfo(`streaming-structured-output (${spec.provider} ${spec.model})`)
  yield* streamRecipes(spec.model).pipe(Effect.provide(languageModelLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
