/**
 * Runtime-agnostic composition of the deep-research recipe.
 *
 * Same two-flag provider selection as grounded-answer (`--llm`, `--search`),
 * the recipe config (`QUESTION`, `MODEL`, `SUB_QUESTIONS`, `CONCURRENCY`),
 * and a `main` that renders the recipe's tagged event stream to the
 * terminal: the plan, each sub-agent's searches and answer as they stream,
 * then the synthesized report.
 *
 * The provider Layers require an `HttpClient` but don't bake one in; each
 * runner supplies the platform client and calls the matching `runMain`.
 */
import {
  Config,
  Console,
  Data,
  Effect,
  Layer,
  Logger,
  Match,
  Option,
  Ref,
  References,
  Stream,
} from "effect"
import { layer as exaLayer } from "@effect-uai/exa/ExaSearch"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { layer as perplexityLayer } from "@effect-uai/perplexity/PerplexitySearch"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { layer as tavilyLayer } from "@effect-uai/tavily/TavilySearch"
import { flagValue } from "../_shared/argv.js"
import { deepResearch, type DeepResearchEvent } from "./recipe.js"

// ---------------------------------------------------------------------------
// Provider selection - two orthogonal flags, decoded functionally.
// ---------------------------------------------------------------------------

export type LlmProvider = "openai" | "gemini"
export type SearchProvider = "perplexity" | "exa" | "tavily"

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
  tavily: "tavily",
}

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
// Layers.
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
  Match.when("tavily", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("TAVILY_API_KEY")
        return tavilyLayer({ apiKey })
      }),
    ),
  ),
  Match.exhaustive,
)

// ---------------------------------------------------------------------------
// Recipe config.
// ---------------------------------------------------------------------------

const recipeConfig = (llm: LlmProvider) =>
  Config.all({
    question: Config.string("QUESTION").pipe(
      Config.withDefault(
        "Compare the leading open-source vector databases for production RAG in 2026.",
      ),
    ),
    model: Config.string("MODEL").pipe(Config.withDefault(defaultModel[llm])),
    subQuestions: Config.int("SUB_QUESTIONS").pipe(Config.withDefault(4)),
    concurrency: Config.int("CONCURRENCY").pipe(Config.withDefault(1)),
  })

// ---------------------------------------------------------------------------
// Render the tagged event stream to the terminal.
// ---------------------------------------------------------------------------

const write = (s: string) =>
  Effect.sync(() => {
    process.stdout.write(s)
  })

const render =
  (reportStarted: Ref.Ref<boolean>) =>
  (ev: DeepResearchEvent): Effect.Effect<void> =>
    Match.value(ev).pipe(
      Match.tag("Planned", (e) =>
        write(`\nPlan:\n${e.subQuestions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}\n`),
      ),
      Match.tag("BranchStarted", (e) => write(`\n\n## [${e.index + 1}] ${e.question}\n`)),
      Match.tag("Searching", () => write("  [searching the web…]\n")),
      Match.tag("AnswerDelta", (e) => write(e.text)),
      Match.tag("BranchDone", () => write("\n")),
      Match.tag("ReportDelta", (e) =>
        Ref.getAndSet(reportStarted, true).pipe(
          Effect.flatMap((started) =>
            write(started ? e.text : `\n\n${"=".repeat(60)}\n\n${e.text}`),
          ),
        ),
      ),
      Match.exhaustive,
    )

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const llm = yield* parseFlag("llm", llmAliases, "openai")
  const search = yield* parseFlag("search", searchAliases, "perplexity")
  const cfg = yield* recipeConfig(llm)

  yield* Effect.logInfo(`deep-research (llm: ${llm} ${cfg.model}, search: ${search})`)
  yield* Effect.logInfo(`question: ${cfg.question}`)

  const reportStarted = yield* Ref.make(false)

  yield* deepResearch({
    question: cfg.question,
    model: cfg.model,
    subQuestions: cfg.subQuestions,
    concurrency: cfg.concurrency,
  }).pipe(
    Stream.runForEach(render(reportStarted)),
    Effect.provide(Layer.mergeAll(llmLayerFor(llm), searchLayerFor(search))),
  )

  yield* Console.log("")
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))

// ---------------------------------------------------------------------------
// App-level layer.
// ---------------------------------------------------------------------------

const logLevelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
    return Layer.succeed(References.MinimumLogLevel, level)
  }),
)

export const appLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), logLevelLayer)
