/**
 * Runtime-agnostic composition of the grounded-answer recipe.
 *
 * Two orthogonal provider flags, `--model provider:model` and `--search
 * <provider>`, each resolved to a Layer by `_shared/model.ts`, which also
 * knows the env var holding the key. Both Layers register the generic tags
 * (`LanguageModel`, `WebSearch`), so `recipe.ts` never names a vendor.
 *
 * `main` resolves the flags, runs `groundedAnswer` under those Layers, and
 * prints the answer as it streams. `run.ts` supplies the platform
 * `HttpClient`.
 */
import { Console, Effect, Layer, Option, Stdio, Stream } from "effect"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec, webSearchLayer } from "../_shared/model.js"
import { groundedAnswer } from "./recipe.js"

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const DEFAULT_QUESTION =
  "What were the most significant AI model releases this month, and what makes each notable?"

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    model: parseModelSpec(
      Option.getOrElse(flagValue("model", argv), () => "gpt-5.4-mini"),
      "openai",
    ),
    search: Option.getOrElse(flagValue("search", argv), () => "perplexity"),
    question: Option.getOrElse(flagValue("question", argv), () => DEFAULT_QUESTION),
    maxRounds: intFlag("max-rounds", argv, 5),
    maxResults: intFlag("max-results", argv, 5),
  }
})

// ---------------------------------------------------------------------------
// Bootstrap: resolve flags, run the recipe under the chosen Layers, print
// the grounded answer.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags

  yield* Effect.logInfo(
    `grounded-answer (llm: ${flags.model.provider} ${flags.model.model}, search: ${flags.search})`,
  )
  yield* Effect.logInfo(`question: ${flags.question}`)
  yield* Console.log("")

  // Text deltas go to stdout as they arrive; search calls go to stderr, so
  // the streamed answer stays clean on stdout.
  yield* groundedAnswer({
    question: flags.question,
    model: flags.model.model,
    maxRounds: flags.maxRounds,
    maxResults: flags.maxResults,
  }).pipe(
    Stream.runForEach((event) =>
      event._tag === "TextDelta"
        ? Effect.sync(() => {
            process.stdout.write(event.text)
          })
        : event._tag === "ToolCallStart"
          ? Effect.sync(() => {
              process.stderr.write("\n[searching the web…]\n")
            })
          : Effect.void,
    ),
    Effect.provide(Layer.mergeAll(languageModelLayer(flags.model), webSearchLayer(flags.search))),
  )

  yield* Console.log("")
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
