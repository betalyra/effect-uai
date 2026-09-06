/**
 * Runtime-agnostic composition of the native-grounding recipe.
 *
 * `--provider google|anthropic|openai` is the recipe's subject: each one
 * searches server-side through its own hosted tool, so unlike
 * `grounded-answer` the tool is picked here, next to the Layer, rather than
 * in `recipe.ts`. `--model` overrides the per-provider default; `--question`
 * asks something else.
 *
 * The Layer itself comes from `_shared/model.ts`. `run.ts` supplies the
 * platform `HttpClient`.
 */
import { Console, Effect, Option, Stdio, Stream } from "effect"
import { webSearchTool as anthropicWebSearch } from "@effect-uai/anthropic/Anthropic"
import { googleSearchTool } from "@effect-uai/google/Gemini"
import { webSearchTool as responsesWebSearch } from "@effect-uai/responses/Responses"
import * as Tool from "@effect-uai/core/Tool"
import { flagValue, providerChoice } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer } from "../_shared/model.js"
import { nativeGrounding } from "./recipe.js"

export type Provider = "google" | "anthropic" | "openai"

// ---------------------------------------------------------------------------
// Per-provider wiring: the hosted web-search tool + a sensible default model.
// ---------------------------------------------------------------------------

const webSearchToolFor: Record<Provider, Tool.AnyTool> = {
  google: googleSearchTool,
  anthropic: anthropicWebSearch(),
  openai: responsesWebSearch(),
}

const defaultModel: Record<Provider, string> = {
  google: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5-mini",
}

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const provider = yield* providerChoice("google", "anthropic", "openai")
  return {
    provider,
    model: Option.getOrElse(flagValue("model", argv), () => defaultModel[provider]),
    question: Option.getOrElse(flagValue("question", argv), () => "What are the news from today?"),
  }
})

// ---------------------------------------------------------------------------
// Bootstrap effect: resolve the flag, run the recipe under the chosen
// provider Layer, print the grounded answer.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags

  yield* Effect.logInfo(`native-grounding (provider: ${flags.provider} ${flags.model})`)
  yield* Effect.logInfo(`question: ${flags.question}`)
  yield* Console.log("")

  // The provider searches server-side, so the only events we forward are the
  // model's text deltas: the grounded answer as it is written.
  yield* nativeGrounding({
    question: flags.question,
    model: flags.model,
    searchTool: webSearchToolFor[flags.provider],
  }).pipe(
    Stream.runForEach((event) =>
      event._tag === "TextDelta"
        ? Effect.sync(() => {
            process.stdout.write(event.text)
          })
        : Effect.void,
    ),
    Effect.provide(languageModelLayer(flags)),
  )

  yield* Console.log("")
}).pipe(
  // Print the whole typed error, not a shallow `[Object]`. For a provider
  // rejection that includes the `raw` body, e.g. Gemini's 400 JSON.
  Effect.tapError((error) =>
    Console.error(`\n[native-grounding] request failed:\n${JSON.stringify(error, null, 2)}`),
  ),
)
