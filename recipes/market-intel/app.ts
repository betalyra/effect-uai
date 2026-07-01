/**
 * Composition + reporting for the market-intel recipe.
 *
 * Runtime-agnostic wiring lives here: the Firecrawl read Layer (generic
 * `WebRead` tag) and the Gemini Flash model Layer (generic `LanguageModel`
 * tag), env-driven config (`MODEL`, `URLS`, `CONCURRENCY`), the report
 * formatter, and the bootstrap `main`. The runners supply the platform
 * `HttpClient`.
 *
 * Swapping providers is a one-line change here and nothing else: replace
 * `firecrawlLayer` with any other `WebRead` backend, or `geminiLayer` with any
 * other `LanguageModel`, and `recipe.ts` is untouched.
 */
import { Config, Console, Effect, Layer, Logger, References, Result } from "effect"
import { HttpClient } from "effect/unstable/http"
import { WebRead } from "@effect-uai/core/WebRead"
import { layer as firecrawlLayer } from "@effect-uai/firecrawl/FirecrawlRead"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { layer as jinaLayer } from "@effect-uai/jina/JinaReader"
import { marketIntel, type Product } from "./recipe.js"

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const price = (monthlyUsd: number | null): string =>
  monthlyUsd === null ? "custom" : `$${monthlyUsd}/mo`

const formatProduct = (url: string, p: Product): string => {
  const tiers = p.pricingTiers.map((t) => `${t.name} ${price(t.monthlyUsd)}`).join(", ")
  return [
    `✓ ${p.vendor}: ${p.product}`,
    `  ${p.tagline}`,
    `  free tier: ${p.freeTier ? "yes" : "no"}`,
    `  tiers: ${tiers === "" ? "(none found)" : tiers}`,
    `  features: ${p.keyFeatures.slice(0, 4).join(", ")}`,
    `  ${url}`,
  ].join("\n")
}

const formatRow = (url: string, result: Result.Result<Product, unknown>): string =>
  Result.match(result, {
    onSuccess: (p) => formatProduct(url, p),
    onFailure: (error) => `✗ ${url}\n  failed: ${String(error)}`,
  })

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The web-extraction providers' own pricing pages - a genuinely heterogeneous
// set (credit-based vs per-seat vs tiered), which is exactly what makes
// selector-based scraping fail and schema-driven extraction shine.
const DEFAULT_URLS = [
  "https://www.firecrawl.dev/pricing",
  "https://exa.ai/pricing",
  "https://www.tavily.com/pricing",
  "https://www.scrapingbee.com/pricing/",
]

const recipeConfig = Config.all({
  model: Config.string("MODEL").pipe(Config.withDefault("gemini-2.5-flash")),
  urls: Config.string("URLS").pipe(
    Config.map((s) =>
      s
        .split(",")
        .map((u) => u.trim())
        .filter((u) => u.length > 0),
    ),
    Config.withDefault(DEFAULT_URLS),
  ),
  concurrency: Config.int("CONCURRENCY").pipe(Config.withDefault(3)),
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const cfg = yield* recipeConfig

  yield* Effect.logInfo(`Extracting ${cfg.urls.length} pages with ${cfg.model}...`)

  const rows = yield* marketIntel(cfg)

  yield* Effect.forEach(rows, ([url, result]) => Console.log(`\n${formatRow(url, result)}`), {
    discard: true,
  })
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))

// ---------------------------------------------------------------------------
// App-level layer: Firecrawl (WebRead) + Gemini (LanguageModel) + logging.
// ---------------------------------------------------------------------------

// Pick the WebRead backend from `READ_PROVIDER` (default firecrawl). This is
// the recipe's portability payoff: the read provider swaps here, the recipe
// code does not. Firecrawl needs `FIRECRAWL_API_KEY`, Jina needs
// `JINA_API_KEY`.
const readProviderLayer = Layer.unwrap(
  Effect.gen(function* () {
    const provider = yield* Config.string("READ_PROVIDER").pipe(Config.withDefault("firecrawl"))
    // Both register the generic `WebRead` tag; widen to it so the branches
    // unify (Layer is covariant in its output).
    const layer: Layer.Layer<WebRead, never, HttpClient.HttpClient> =
      provider === "jina"
        ? jinaLayer({ apiKey: yield* Config.redacted("JINA_API_KEY") })
        : firecrawlLayer({ apiKey: yield* Config.redacted("FIRECRAWL_API_KEY") })
    return layer
  }),
)

const geminiProviderLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return geminiLayer({ apiKey })
  }),
)

const logLevelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
    return Layer.succeed(References.MinimumLogLevel, level)
  }),
)

export const appLayer = Layer.mergeAll(
  readProviderLayer,
  geminiProviderLayer,
  Logger.layer([Logger.consolePretty()]),
  logLevelLayer,
)
