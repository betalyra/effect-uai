/**
 * Composition + reporting for the market-intel recipe.
 *
 * Runtime-agnostic wiring lives here: flags (`--model`, `--read`, `--urls`,
 * `--concurrency`), the report formatter, and the bootstrap `main`. `run.ts`
 * supplies the platform `HttpClient`.
 *
 * The portability payoff is `--read`: the page reader swaps between
 * Firecrawl, Jina, Exa and Tavily and `recipe.ts` is untouched, because it
 * only ever names the generic `WebRead` tag.
 */
import { Console, Effect, Layer, Option, Result, Stdio } from "effect"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec, webReadLayer } from "../_shared/model.js"
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

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    model: parseModelSpec(
      Option.getOrElse(flagValue("model", argv), () => "gemini-2.5-flash"),
      "google",
    ),
    read: Option.getOrElse(flagValue("read", argv), () => "firecrawl"),
    urls: Option.match(flagValue("urls", argv), {
      onNone: (): ReadonlyArray<string> => DEFAULT_URLS,
      onSome: (raw) =>
        raw
          .split(",")
          .map((u) => u.trim())
          .filter((u) => u.length > 0),
    }),
    concurrency: intFlag("concurrency", argv, 3),
  }
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags

  yield* Effect.logInfo(
    `Extracting ${flags.urls.length} pages with ${flags.read} + ${flags.model.model}...`,
  )

  const rows = yield* marketIntel({ ...flags, model: flags.model.model }).pipe(
    Effect.provide(Layer.merge(webReadLayer(flags.read), languageModelLayer(flags.model))),
  )

  yield* Effect.forEach(rows, ([url, result]) => Console.log(`\n${formatRow(url, result)}`), {
    discard: true,
  })
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
