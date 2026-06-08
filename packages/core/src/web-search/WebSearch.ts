import { Context, type DateTime, Effect, Schema } from "effect"
import type * as AiError from "../domain/AiError.js"

// ---------------------------------------------------------------------------
// Recency
// ---------------------------------------------------------------------------

/**
 * Convenience freshness enum shared by every provider. A coarse "published
 * within the last …" filter that maps onto each provider's native recency
 * knob (Perplexity `search_recency_filter`, Brave `freshness`, Tavily
 * `time_range`, You.com `freshness`), or onto a computed published-date
 * range where a provider has no enum (Exa).
 *
 * For a precise window use {@link CommonSearchRequest.startDate} /
 * {@link CommonSearchRequest.endDate} instead; `recency` is the sugar for
 * the common "past week / past month" case.
 *
 * Exposed as a `Schema` so {@link "../web-search/WebSearchTool".webSearchTool}
 * can hand it straight to a model as a tool parameter; the
 * {@link SearchRecency} type is derived from it.
 */
export const SearchRecency = Schema.Literals(["hour", "day", "week", "month", "year"])

export type SearchRecency = typeof SearchRecency.Type

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Cross-provider web-search request. A field earns a place here only if
 * most of the supported providers honor it and a developer would expect it
 * from a generic search interface; everything provider-specific (Exa
 * `type`, Tavily `searchDepth`, Brave `goggles`, pagination `offset`,
 * `safeSearch`, `topic`, …) lives on that provider's typed request.
 *
 * Note the one structural difference from `EmbeddingModel` /
 * `Transcriber`: there is no `model`. None of the pure-`/search` endpoints
 * take one - what looks model-shaped on a provider (Exa `type`, Tavily
 * `searchDepth`) is a mode knob, so it stays on the provider-typed request.
 */
export type CommonSearchRequest = {
  /** The search query. The one field every provider requires. */
  readonly query: string
  /**
   * Upper bound on the number of results to return in this one call.
   * Providers cap differently (Perplexity / Tavily / Brave at ~20, Exa /
   * You.com at ~100); a value above a provider's cap is clamped by that
   * provider. There is no common pagination - only two providers paginate
   * and only shallowly, so `offset` is provider-typed.
   */
  readonly maxResults?: number
  /** Restrict results to these domains (e.g. `["docs.foo.com"]`). */
  readonly includeDomains?: ReadonlyArray<string>
  /** Drop results from these domains. */
  readonly excludeDomains?: ReadonlyArray<string>
  /**
   * Coarse freshness filter - see {@link SearchRecency}. Sugar over an
   * explicit `startDate`; ignored where {@link startDate} is also set and
   * the provider takes only one.
   */
  readonly recency?: SearchRecency
  /** Published-after bound. The precise alternative to {@link recency}. */
  readonly startDate?: DateTime.DateTime
  /** Published-before bound. */
  readonly endDate?: DateTime.DateTime
  /** ISO 3166-1 alpha-2 country code to localize results (e.g. `"us"`). */
  readonly country?: string
  /** ISO 639-1 language code to bias results toward (e.g. `"en"`). */
  readonly language?: string
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * One normalized web-search hit. A flat record with optionals rather than a
 * tagged union: the providers differ by *which fields are present*, not by
 * *kind*. The provider's untouched result object is always on `raw`, so a
 * caller holding a typed provider tag can recover anything not promoted
 * here (`author`, `favicon`, multi-chunk `snippets[]`, …).
 */
export type SearchResult = {
  /** Canonical result URL. Always present. */
  readonly url: string
  /** Result title / headline, when the provider returns one. */
  readonly title?: string
  /**
   * Primary short excerpt - the one text field all providers return (under
   * various wire names: `snippet`, `content`, `description`). The richer
   * extract fields (`text`, `highlights`, `summary`) belong to the
   * out-of-scope extract feature and stay on the provider-typed result.
   */
  readonly snippet?: string
  /** Publication date, when the provider reports one. */
  readonly publishedDate?: DateTime.DateTime
  /**
   * Relevance score, only from providers that rank (Exa, Tavily);
   * `undefined` for providers that return an unscored list. Kept despite
   * being non-universal because ranking is core to what a "search result"
   * means - and `undefined` cleanly says "this backend doesn't score."
   */
  readonly score?: number
  /** The provider-native result object, never lossy. */
  readonly raw: unknown
}

export type SearchResponse = {
  readonly results: ReadonlyArray<SearchResult>
  /**
   * The provider-native top-level response object. Cost / usage reporting
   * is deliberately not modeled on this surface yet: providers disagree on
   * both what (Exa returns USD, Tavily credits, Brave nothing in-body) and
   * where (Brave reports cost in response headers), so it is deferred to the
   * unified usage design (see plans/usage-tracking.md). Anything a provider
   * reports survives here on `raw`.
   */
  readonly raw: unknown
}

// ---------------------------------------------------------------------------
// Service + helper
// ---------------------------------------------------------------------------

/**
 * The portable web-search surface: one operation, `search`. Pure search is
 * the one thing every provider does, so - unlike `SpeechSynthesizer` /
 * `Transcriber` - this capability needs no marker tags; every provider
 * Layer can answer.
 */
export type WebSearchService = {
  readonly search: (request: CommonSearchRequest) => Effect.Effect<SearchResponse, AiError.AiError>
}

/**
 * Generic web-search service tag. Yield this for provider-portable code;
 * yield a provider tag (`PerplexitySearch`, `ExaSearch`, …) when you need
 * that provider's own knobs. A provider's `layer` registers both.
 */
export class WebSearch extends Context.Service<WebSearch, WebSearchService>()(
  "@betalyra/effect-uai/WebSearch",
) {}

/** Run one web search against whichever provider Layer is in scope. */
export const search = (
  request: CommonSearchRequest,
): Effect.Effect<SearchResponse, AiError.AiError, WebSearch> =>
  Effect.flatMap(WebSearch.asEffect(), (s) => s.search(request))
