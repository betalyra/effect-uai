/**
 * Runtime-agnostic composition of the grounded-answer recipe.
 *
 * Everything that doesn't depend on Bun / Node / Deno lives here:
 *   - two independent provider flags, parsed from argv (no throwing - an
 *     unknown value fails the program with a typed `UnknownFlag`):
 *       --llm=openai|gemini       (default openai)
 *       --search=perplexity       (default perplexity; exa / tavily / ...
 *                                  slot in as one alias + one Match arm)
 *   - the LLM and search Layers, each registering its generic tag
 *     (`LanguageModel`, `WebSearch`) so `recipe.ts` never names a provider
 *   - recipe config (`QUESTION`, `MODEL`, `MAX_ROUNDS`, `MAX_RESULTS`)
 *   - the bootstrap `main` effect: resolve flags, run `groundedAnswer`
 *     under the chosen provider Layers, print the answer
 *   - logger + log-level layer
 *
 * The provider Layers require an `HttpClient` but don't bake one in; each
 * runner (`run-node.ts`, `run-bun.ts`, `run-deno.ts`) supplies the platform
 * client and calls the matching `runMain`.
 */
import { Config, Console, Data, Effect, Layer, Logger, Match, Option, References } from "effect"
import { layer as exaLayer } from "@effect-uai/exa/ExaSearch"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { layer as perplexityLayer } from "@effect-uai/perplexity/PerplexitySearch"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { flagValue } from "../_shared/argv.js"
import { groundedAnswer } from "./recipe.js"

// ---------------------------------------------------------------------------
// Provider selection - two orthogonal flags, decoded functionally.
// ---------------------------------------------------------------------------

export type LlmProvider = "openai" | "gemini"
// New search backends (tavily, you, brave) are added as one alias entry
// below + one Match arm in `searchLayerFor` - nothing in `recipe.ts`
// changes.
export type SearchProvider = "perplexity" | "exa"

const argv = process.argv.slice(2)

class UnknownFlag extends Data.TaggedError("UnknownFlag")<{
  readonly flag: string
  readonly value: string
  readonly expected: string
}> {}

const llmAliases: Record<string, LlmProvider> = {
  openai: "openai",
  oai: "openai",
  gemini: "gemini",
  google: "gemini",
}

const searchAliases: Record<string, SearchProvider> = {
  perplexity: "perplexity",
  pplx: "perplexity",
  exa: "exa",
}

// Resolve a `--flag` against an alias table. Absent -> fallback; present
// but unrecognized -> typed failure listing the accepted values.
const parseFlag = <A extends string>(
  flag: string,
  aliases: Record<string, A>,
  fallback: A,
): Effect.Effect<A, UnknownFlag> =>
  Option.match(flagValue(flag, argv), {
    onNone: (): Effect.Effect<A, UnknownFlag> => Effect.succeed(fallback),
    onSome: (raw): Effect.Effect<A, UnknownFlag> =>
      Option.match(Option.fromNullishOr(aliases[raw.toLowerCase()]), {
        onNone: () =>
          Effect.fail(
            new UnknownFlag({
              flag,
              value: raw,
              expected: [...new Set(Object.values(aliases))].join(" | "),
            }),
          ),
        onSome: (a) => Effect.succeed(a),
      }),
  })

const defaultModel: Record<LlmProvider, string> = {
  openai: "gpt-5.4-mini",
  gemini: "gemini-2.5-flash",
}

// ---------------------------------------------------------------------------
// Layers. Each registers its generic tag; the recipe yields only the
// generic tags, so swapping providers here is the whole change. Provider
// Layers require an HttpClient, supplied by the runner.
// ---------------------------------------------------------------------------

const llmLayerFor = Match.type<LlmProvider>().pipe(
  Match.when("openai", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("OPENAI_API_KEY")
        return responsesLayer({ apiKey })
      }),
    ),
  ),
  Match.when("gemini", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
        return geminiLayer({ apiKey })
      }),
    ),
  ),
  Match.exhaustive,
)

const searchLayerFor = Match.type<SearchProvider>().pipe(
  Match.when("perplexity", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("PERPLEXITY_API_KEY")
        return perplexityLayer({ apiKey })
      }),
    ),
  ),
  Match.when("exa", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("EXA_API_KEY")
        return exaLayer({ apiKey })
      }),
    ),
  ),
  Match.exhaustive,
)

// ---------------------------------------------------------------------------
// Recipe config (env-driven via Config). Model default follows the LLM.
// ---------------------------------------------------------------------------

const recipeConfig = (llm: LlmProvider) =>
  Config.all({
    question: Config.string("QUESTION").pipe(
      Config.withDefault(
        "What were the most significant AI model releases this month, and what makes each notable?",
      ),
    ),
    model: Config.string("MODEL").pipe(Config.withDefault(defaultModel[llm])),
    maxRounds: Config.int("MAX_ROUNDS").pipe(Config.withDefault(5)),
    maxResults: Config.int("MAX_RESULTS").pipe(Config.withDefault(5)),
  })

// ---------------------------------------------------------------------------
// Bootstrap effect: resolve flags, run the recipe under the chosen
// provider Layers, print the grounded answer.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const llm = yield* parseFlag("llm", llmAliases, "openai")
  const search = yield* parseFlag("search", searchAliases, "perplexity")
  const cfg = yield* recipeConfig(llm)

  yield* Effect.logInfo(`grounded-answer (llm: ${llm} ${cfg.model}, search: ${search})`)
  yield* Effect.logInfo(`question: ${cfg.question}`)

  const result = yield* groundedAnswer({
    question: cfg.question,
    model: cfg.model,
    maxRounds: cfg.maxRounds,
    maxResults: cfg.maxResults,
  }).pipe(Effect.provide(Layer.mergeAll(llmLayerFor(llm), searchLayerFor(search))))

  yield* Effect.logInfo(`answered after ${result.rounds} search round(s)`)
  yield* Console.log(`\n${result.answer}\n`)
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))

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
