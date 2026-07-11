/**
 * Runtime-agnostic composition of the native-grounding recipe.
 *
 * Everything that doesn't depend on Bun / Node / Deno lives here:
 *   - one provider flag (`--provider=google|anthropic|openai`, default google),
 *     resolved by the shared `providerChoice` helper (typed failure on an
 *     unknown value)
 *   - per-provider wiring: the LLM Layer (registering the generic
 *     `LanguageModel` tag) AND the matching hosted web-search tool. Unlike
 *     `grounded-answer`, the tool is provider-specific, so it is chosen here
 *     next to the Layer instead of in `recipe.ts`.
 *   - recipe config (`QUESTION`, `MODEL`)
 *   - the bootstrap `main` effect: resolve the flag, run `nativeGrounding`
 *     under the chosen provider Layer, stream the grounded answer to stdout
 *   - logger + log-level layer
 *
 * The provider Layers require an `HttpClient` but don't bake one in; each
 * runner supplies the platform client and calls the matching `runMain`.
 */
import { Config, Console, Effect, Layer, Logger, Match, References, Stream } from "effect"
import {
  layer as anthropicLayer,
  webSearchTool as anthropicWebSearch,
} from "@effect-uai/anthropic/Anthropic"
import { layer as geminiLayer, googleSearchTool } from "@effect-uai/google/Gemini"
import {
  layer as responsesLayer,
  webSearchTool as responsesWebSearch,
} from "@effect-uai/responses/Responses"
import * as Tool from "@effect-uai/core/Tool"
import { providerChoice } from "../_shared/argv.js"
import { nativeGrounding } from "./recipe.js"

export type Provider = "google" | "anthropic" | "openai"

// ---------------------------------------------------------------------------
// Per-provider wiring: the hosted web-search tool + a sensible default model.
// The Layer (below) registers the generic `LanguageModel` tag.
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

const llmLayerFor = Match.type<Provider>().pipe(
  Match.when("google", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
        return geminiLayer({ apiKey })
      }),
    ),
  ),
  Match.when("anthropic", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY")
        return anthropicLayer({ apiKey })
      }),
    ),
  ),
  Match.when("openai", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("OPENAI_API_KEY")
        return responsesLayer({ apiKey })
      }),
    ),
  ),
  Match.exhaustive,
)

// ---------------------------------------------------------------------------
// Recipe config (env-driven via Config). Model default follows the provider.
// ---------------------------------------------------------------------------

const recipeConfig = (provider: Provider) =>
  Config.all({
    question: Config.string("QUESTION").pipe(Config.withDefault("What are the news from today?")),
    model: Config.string("MODEL").pipe(Config.withDefault(defaultModel[provider])),
  })

// ---------------------------------------------------------------------------
// Bootstrap effect: resolve the flag, run the recipe under the chosen
// provider Layer, print the grounded answer.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const provider = yield* providerChoice("google", "anthropic", "openai")
  const cfg = yield* recipeConfig(provider)

  yield* Effect.logInfo(`native-grounding (provider: ${provider} ${cfg.model})`)
  yield* Effect.logInfo(`question: ${cfg.question}`)
  yield* Console.log("")

  // The provider searches server-side, so the only events we forward are the
  // model's text deltas — the grounded answer as it is written.
  yield* nativeGrounding({
    question: cfg.question,
    model: cfg.model,
    searchTool: webSearchToolFor[provider],
  }).pipe(
    Stream.runForEach((event) =>
      event._tag === "TextDelta"
        ? Effect.sync(() => {
            process.stdout.write(event.text)
          })
        : Effect.void,
    ),
    Effect.provide(llmLayerFor(provider)),
  )

  yield* Console.log("")
}).pipe(
  // Print the whole typed error — for a provider rejection this includes the
  // `raw` body, e.g. Gemini's 400 JSON — instead of a shallow `[Object]`.
  Effect.tapError((error) =>
    Console.error(`\n[native-grounding] request failed:\n${JSON.stringify(error, null, 2)}`),
  ),
)

// ---------------------------------------------------------------------------
// App-level layer: everything that's NOT platform-specific. Runners merge
// this with their platform HttpClient and call `runMain`.
// ---------------------------------------------------------------------------

const logLevelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
    return Layer.succeed(References.MinimumLogLevel, level)
  }),
)

export const appLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), logLevelLayer)
