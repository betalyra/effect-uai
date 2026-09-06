/**
 * Composition for the multivector-embedding recipe: `--model provider:model`
 * resolved to a Layer by `_shared/model.ts`. The recipe asks for Jina's typed
 * tag, since `encoding: "multivector"` is that provider's own knob.
 */
import { Effect, Option, Stdio } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { multivectorEmbeddingLayer, parseModelSpec } from "../_shared/model.js"
import { rank } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => "jina-embeddings-v4"),
    "jina",
  )

  yield* Effect.logInfo(`multivector-embedding (${spec.provider} ${spec.model})`)
  yield* rank(spec.model).pipe(Effect.provide(multivectorEmbeddingLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
