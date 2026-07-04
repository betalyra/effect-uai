/**
 * Market intelligence by structured extraction. Point it at a list of vendor
 * pricing pages and get back one typed, validated pricing record per page,
 * extracted concurrently.
 *
 * Each vendor lays its pricing out differently, so there are no selectors to
 * write: `WebRead.read(url)` fetches clean markdown and a `structured` model
 * turn decodes it against your `Schema`. Swap the read backend or the model by
 * changing only the Layers in `app.ts`.
 */
import { Effect, Option, Result, Schema, Stream } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"
import * as WebRead from "@effect-uai/core/WebRead"

// ---------------------------------------------------------------------------
// Schema - the shape we pull out of every (differently-laid-out) page
// ---------------------------------------------------------------------------

const PricingTier = Schema.Struct({
  /** Tier name as shown on the page (e.g. "Free", "Pro", "Enterprise"). */
  name: Schema.String,
  /** Monthly price in USD, or null for "custom" / "contact us" tiers. */
  monthlyUsd: Schema.NullOr(Schema.Number),
})

export const Product = Schema.Struct({
  vendor: Schema.String,
  product: Schema.String,
  tagline: Schema.String,
  freeTier: Schema.Boolean,
  pricingTiers: Schema.Array(PricingTier),
  keyFeatures: Schema.Array(Schema.String),
})
export type Product = typeof Product.Type

const productFormat = StructuredFormat.fromEffectSchema(Product)

/** Typed failure channel for a single page's extraction: read + turn + decode. */
export type ExtractError =
  | AiError.AiError
  | Turn.RefusalRejected
  | StructuredFormat.JsonParseError
  | StructuredFormat.StructuredDecodeError

// ---------------------------------------------------------------------------
// Per-page extraction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You extract structured product and pricing data from a SaaS vendor page.",
  "You are given the page as clean markdown. Fill every field of the schema",
  "from the page only - do not invent tiers or features. Use an empty array",
  "when a list is absent, and null for a tier whose price is custom or",
  "contact-sales. Report monthly prices (convert annual-billed figures to the",
  "monthly equivalent).",
].join(" ")

export type MarketIntelConfig = {
  readonly model: string
  readonly urls: ReadonlyArray<string>
  readonly concurrency: number
}

/** Fold a `structured` model turn down to its decoded value. */
const decodePage = (
  model: string,
  markdown: string,
): Effect.Effect<Product, ExtractError, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const turn = yield* LanguageModel.streamTurn({
      model,
      history: [Items.systemText(SYSTEM_PROMPT), Items.userText(markdown)],
      structured: productFormat,
    }).pipe(
      Stream.filterMap((e) => (Turn.isTurnComplete(e) ? Result.succeed(e.turn) : Result.failVoid)),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () => Effect.fail(new AiError.IncompleteTurn({})),
        }),
      ),
    )
    return yield* Turn.decodeStructured(turn, productFormat)
  })

/** Read one URL to markdown, then extract the typed `Product` from it. */
export const extractProduct = (
  cfg: MarketIntelConfig,
  url: string,
): Effect.Effect<Product, ExtractError, WebRead.WebRead | LanguageModel.LanguageModel> =>
  Effect.flatMap(WebRead.read({ url }), (page) => decodePage(cfg.model, page.content))

/** One input URL paired with its extraction outcome. */
export type ExtractRow = readonly [url: string, result: Result.Result<Product, ExtractError>]

/**
 * The recipe: extract every URL concurrently, each paired with its outcome. A
 * failed page (fetch error, model error, schema mismatch) is captured as a
 * `Result.Failure` rather than collapsing the batch. `concurrency` is capped
 * for the read provider's QPS.
 */
export const marketIntel = (
  cfg: MarketIntelConfig,
): Effect.Effect<ReadonlyArray<ExtractRow>, never, WebRead.WebRead | LanguageModel.LanguageModel> =>
  Effect.forEach(
    cfg.urls,
    (url) =>
      Effect.result(extractProduct(cfg, url)).pipe(
        Effect.map((result): ExtractRow => [url, result]),
      ),
    { concurrency: cfg.concurrency },
  )
