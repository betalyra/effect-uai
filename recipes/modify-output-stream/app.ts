/**
 * Composition for the modify-output-stream recipe. Runs the loop twice and
 * prints both wire formats, so you can copy a frame straight from the
 * terminal. The projections themselves (`toSSE` / `toJSONL`) live in
 * `recipe.ts`; mapping them over the loop's output is the whole transport
 * layer.
 */
import { Console, Effect, Option, Stdio, Stream } from "effect"
import * as SSE from "@effect-uai/core/SSE"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { conversation, toJSONL, toSSE } from "./recipe.js"

const decoder = new TextDecoder("utf-8")

const both = (model: string) =>
  Effect.gen(function* () {
    const events = conversation(model)

    yield* Console.log("--- as SSE bytes -----------------------------------")
    const sseBytes = events.pipe(Stream.filterMap(toSSE), SSE.toBytes)
    yield* Stream.runForEach(sseBytes, (chunk) => Console.log(decoder.decode(chunk).trimEnd()))

    yield* Console.log("\n--- as JSONL lines ---------------------------------")
    yield* Stream.runForEach(events.pipe(Stream.filterMap(toJSONL)), (line: string) =>
      Console.log(line.trimEnd()),
    )
  })

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => "gpt-5.4-mini"),
    "openai",
  )
  yield* both(spec.model).pipe(Effect.provide(languageModelLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
