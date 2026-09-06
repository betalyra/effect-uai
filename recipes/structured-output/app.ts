/**
 * Composition for the structured-output recipe: `--model provider:model`
 * resolved to a Layer by `_shared/model.ts`, `--prompt` to ask for something
 * else, and a `main` that logs the decoded object. `run.ts` supplies the
 * platform `HttpClient`.
 */
import { Effect, Option, Stdio } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { DEFAULT_PROMPT, structuredRecipe } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => "gpt-5.4-mini"),
    "openai",
  )
  const prompt = Option.getOrElse(flagValue("prompt", argv), () => DEFAULT_PROMPT)

  yield* Effect.logInfo(`structured-output (${spec.provider} ${spec.model})`)

  const recipe = yield* structuredRecipe(spec.model, prompt).pipe(
    Effect.provide(languageModelLayer(spec)),
  )
  yield* Effect.logInfo("recipe", { recipe })
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
