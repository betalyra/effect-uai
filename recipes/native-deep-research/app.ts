/**
 * Runtime-agnostic composition of the native-deep-research recipe.
 *
 * Everything that doesn't depend on Bun / Node / Deno lives here:
 *   - one provider flag (`--provider=perplexity|openai`, default perplexity),
 *     resolved by the shared `providerChoice` helper (typed failure on an
 *     unknown value). Both ship a provider-hosted `DeepResearch` job; the recipe
 *     runs against the generic tag, so swapping providers changes only the Layer.
 *   - per-provider wiring: the deep-research Layer (registering the generic
 *     `DeepResearch` tag) and a default model id
 *   - recipe config (`QUESTION`, optional `MODEL`, `OUTPUT` markdown path)
 *   - the bootstrap `main` effect: resolve the flag, stream `nativeDeepResearch`
 *     under the chosen provider Layer, render live progress, then print + save
 *     the cited report
 *   - logger + log-level layer
 *
 * The provider Layers require an `HttpClient` and the report is saved through the
 * platform `FileSystem`; each runner supplies both. A real run takes minutes: the
 * job runs server-side and the stream reports progress until it completes.
 */
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Match,
  Option,
  Ref,
  References,
  Stream,
} from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"
import { layer as exaLayer } from "@effect-uai/exa/ExaDeepResearch"
import { layer as googleLayer } from "@effect-uai/google/GoogleDeepResearch"
import { layer as perplexityLayer } from "@effect-uai/perplexity/PerplexityDeepResearch"
import { layer as openaiLayer } from "@effect-uai/responses/OpenAIDeepResearch"
import { providerChoice } from "../_shared/argv.js"
import { nativeDeepResearch } from "./recipe.js"

export type Provider = "perplexity" | "openai" | "google" | "exa"

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const write = (s: string) =>
  Effect.sync(() => {
    process.stdout.write(s)
  })

// ---------------------------------------------------------------------------
// Per-provider wiring: a default deep-research model. The Layer (below)
// registers the generic `DeepResearch` tag.
// ---------------------------------------------------------------------------

const defaultModel: Record<Provider, string> = {
  perplexity: "sonar-deep-research",
  openai: "o3-deep-research",
  google: "deep-research-preview-04-2026",
  exa: "exa-research",
}

const researchLayerFor = Match.type<Provider>().pipe(
  Match.when("perplexity", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("PERPLEXITY_API_KEY")
        return perplexityLayer({ apiKey })
      }),
    ),
  ),
  Match.when("openai", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("OPENAI_API_KEY")
        return openaiLayer({ apiKey })
      }),
    ),
  ),
  Match.when("google", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
        return googleLayer({ apiKey })
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
// Recipe config (env-driven via Config). Model default follows the provider.
// ---------------------------------------------------------------------------

const recipeConfig = (provider: Provider) =>
  Config.all({
    question: Config.string("QUESTION").pipe(
      Config.withDefault(
        "What are the most significant AI research developments of the past month?",
      ),
    ),
    model: Config.string("MODEL").pipe(Config.withDefault(defaultModel[provider])),
    output: Config.string("OUTPUT").pipe(Config.withDefault("deep-research-report.md")),
  })

const urlCitations = (turn: Turn.Turn) => Turn.citations(turn).filter(Items.isUrlCitation)

const toMarkdown = (question: string, turn: Turn.Turn): string => {
  const sources = urlCitations(turn)
  const body = [`# Deep research report`, ``, `> ${question}`, ``, Turn.assistantText(turn)]
  const sourceList =
    sources.length === 0
      ? []
      : [
          "",
          "## Sources",
          "",
          ...sources.map((c, i) => `${i + 1}. [${c.title ?? c.url}](${c.url})`),
        ]
  return [...body, ...sourceList, ""].join("\n")
}

// ---------------------------------------------------------------------------
// Bootstrap effect: resolve the flag, stream the recipe under the chosen
// provider Layer rendering live progress, then print + save the report.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const provider = yield* providerChoice("perplexity", "openai", "google", "exa")
  const cfg = yield* recipeConfig(provider)
  const fs = yield* FileSystem.FileSystem

  yield* Effect.logInfo(`native-deep-research (provider: ${provider} ${cfg.model})`)
  yield* Effect.logInfo(`question: ${cfg.question}`)
  yield* Effect.logInfo(
    "the job runs server-side for minutes; streaming progress until it completes...",
  )
  yield* Console.log("")

  // Search-lifecycle + reasoning render dimmed as they arrive; `TextDelta`
  // (streaming providers) prints the report as it is written. Poll-only
  // providers emit no `TextDelta`, so the report lives only in the terminal
  // `Turn` — captured here and printed after the stream if it was not streamed.
  const streamed = yield* Ref.make(false)
  const finalTurn = yield* Ref.make(Option.none<Turn.Turn>())

  yield* nativeDeepResearch({ question: cfg.question, model: cfg.model }).pipe(
    Stream.runForEach(
      Match.type<Turn.TurnEvent>().pipe(
        Match.tag("WebSearchCall", (e) =>
          Console.log(dim(`  · ${e.status}${e.query !== undefined ? `: ${e.query}` : ""}`)),
        ),
        Match.tag("ReasoningDelta", (e) => write(dim(e.text))),
        Match.tag("TextDelta", (e) =>
          Effect.gen(function* () {
            yield* Ref.set(streamed, true)
            yield* write(e.text)
          }),
        ),
        Match.tag("TurnComplete", (e) => Ref.set(finalTurn, Option.some(e.turn))),
        Match.orElse(() => Effect.void),
      ),
    ),
    Effect.provide(researchLayerFor(provider)),
  )

  yield* Option.match(yield* Ref.get(finalTurn), {
    onNone: () => Console.log("\n(no report was produced)"),
    onSome: (turn) =>
      Effect.gen(function* () {
        // Print the report body unless it already streamed token-by-token.
        if (!(yield* Ref.get(streamed))) yield* Console.log(`\n${Turn.assistantText(turn)}`)

        const sources = urlCitations(turn)
        if (sources.length > 0) {
          yield* Console.log("\nSources:")
          yield* Effect.forEach(sources, (c, i) =>
            Console.log(`  [${i + 1}] ${c.title ?? c.url} — ${c.url}`),
          )
        }

        yield* fs.writeFileString(cfg.output, toMarkdown(cfg.question, turn))
        yield* Console.log(`\nReport saved to ${cfg.output}`)
      }),
  })
}).pipe(
  // Print the whole typed error — for a provider rejection this includes the
  // `raw` body — instead of a shallow `[Object]`.
  Effect.tapError((error) =>
    Console.error(`\n[native-deep-research] request failed:\n${JSON.stringify(error, null, 2)}`),
  ),
)

// ---------------------------------------------------------------------------
// App-level layer: everything that's NOT platform-specific. Runners merge this
// with their platform HttpClient + FileSystem and call `runMain`.
// ---------------------------------------------------------------------------

const logLevelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
    return Layer.succeed(References.MinimumLogLevel, level)
  }),
)

export const appLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), logLevelLayer)
