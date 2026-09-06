/**
 * Composition for the multimodal-embedding recipe: `--model provider:model`
 * resolved to a Layer by `_shared/model.ts`. Cross-modal ranking needs a
 * model that embeds images and text into the same space.
 */
import { Effect, Option, Stdio } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { embeddingModelLayer, parseModelSpec } from "../_shared/model.js"
import { rank } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => "gemini-embedding-2"),
    "google",
  )

  yield* Effect.logInfo(`multimodal-embedding (${spec.provider} ${spec.model})`)
  yield* rank(spec.model).pipe(Effect.provide(embeddingModelLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
