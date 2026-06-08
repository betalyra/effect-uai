import { Context, DateTime, Effect, Layer, Option, type Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import {
  type CommonSearchRequest,
  type SearchResponse,
  type SearchResult,
  WebSearch,
  type WebSearchService,
} from "@effect-uai/core/WebSearch"
import type { TavilySearchDepth, TavilyTopic } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Tavily-typed search request. Widens {@link CommonSearchRequest} with
 * Tavily's own knobs; the common fields map onto Tavily's wire filters (see
 * the codec below). There is no `model` - `/search` ranks the web directly.
 */
export type TavilySearchRequest = CommonSearchRequest & {
  /** Latency / credit-cost trade-off - see {@link TavilySearchDepth}. */
  readonly searchDepth?: TavilySearchDepth
  /** Index vertical - see {@link TavilyTopic}. */
  readonly topic?: TavilyTopic
  /** Content chunks extracted per source (1..3). */
  readonly chunksPerSource?: number
}

export type TavilySearchService = {
  readonly search: (request: TavilySearchRequest) => Effect.Effect<SearchResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Tavily-typed search
 * (`searchDepth`, `topic`, the per-result `score`); yield the generic
 * `WebSearch` tag for provider-portable code. Both are registered by
 * {@link layer}.
 */
export class TavilySearch extends Context.Service<TavilySearch, TavilySearchService>()(
  "@betalyra/effect-uai/providers/tavily/TavilySearch",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

type WireBody = {
  readonly query: string
  readonly search_depth?: string
  readonly topic?: string
  readonly max_results?: number
  readonly include_domains?: ReadonlyArray<string>
  readonly exclude_domains?: ReadonlyArray<string>
  readonly time_range?: string
  readonly start_date?: string
  readonly end_date?: string
  readonly chunks_per_source?: number
}

// Tavily's `time_range` has no sub-day granularity, so `recency: "hour"`
// has no home (warned + dropped in `searchImpl`); the rest map 1:1.
const timeRange: Partial<Record<NonNullable<CommonSearchRequest["recency"]>, string>> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
}

const buildBody = (request: TavilySearchRequest): WireBody => ({
  query: request.query,
  ...(request.searchDepth !== undefined && { search_depth: request.searchDepth }),
  ...(request.topic !== undefined && { topic: request.topic }),
  ...(request.maxResults !== undefined && { max_results: request.maxResults }),
  ...(request.includeDomains !== undefined && { include_domains: request.includeDomains }),
  ...(request.excludeDomains !== undefined && { exclude_domains: request.excludeDomains }),
  ...(request.recency !== undefined &&
    timeRange[request.recency] !== undefined && { time_range: timeRange[request.recency] }),
  // Tavily dates are calendar dates (YYYY-MM-DD), in UTC.
  ...(request.startDate !== undefined && {
    start_date: DateTime.formatIsoDateUtc(request.startDate),
  }),
  ...(request.endDate !== undefined && { end_date: DateTime.formatIsoDateUtc(request.endDate) }),
  ...(request.chunksPerSource !== undefined && { chunks_per_source: request.chunksPerSource }),
})

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireResult = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.String,
  content: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Number),
  published_date: Schema.optional(Schema.NullOr(Schema.String)),
})
type WireResult = typeof WireResult.Type

const WireResponse = Schema.Struct({
  query: Schema.optional(Schema.String),
  results: Schema.Array(WireResult),
  request_id: Schema.optional(Schema.String),
})
type WireResponse = typeof WireResponse.Type

/** Lenient parse of Tavily's date strings; unparseable -> omitted. */
const parseDate = (s: string | null | undefined): DateTime.DateTime | undefined =>
  s == null ? undefined : Option.getOrUndefined(DateTime.make(s))

const toResult = (r: WireResult): SearchResult => {
  const publishedDate = parseDate(r.published_date)
  return {
    url: r.url,
    ...(r.title != null && { title: r.title }),
    ...(r.content !== undefined && { snippet: r.content }),
    ...(r.score !== undefined && { score: r.score }),
    ...(publishedDate !== undefined && { publishedDate }),
    raw: r,
  }
}

const toResponse = (wire: WireResponse): SearchResponse => ({
  results: wire.results.map(toResult),
  raw: wire,
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "tavily", raw: cause })

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "tavily"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402 || status === 432 || status === 433) {
    return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  }
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.tavily.com"

const postSearch = (
  cfg: Config,
  body: WireBody,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/search`).pipe(
      HttpClientRequest.bearerToken(cfg.apiKey),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    return yield* Schema.decodeUnknownEffect(WireResponse)(json).pipe(
      Effect.mapError(transportFailure),
    )
  })

const searchImpl =
  (cfg: Config) =>
  (
    request: TavilySearchRequest,
  ): Effect.Effect<SearchResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      // Bucket-2 gaps (warn, don't fail):
      // - Tavily has no language filter.
      yield* Capabilities.warnDroppedWhen(request.language, {
        provider: "tavily",
        capability: "language",
        field: "language",
        reason: "Tavily /search has no language filter; the hint is ignored.",
      })
      // - Tavily `country` takes full country names (lowercase), not ISO
      //   alpha-2 codes, so the cross-provider `country` can't be forwarded.
      yield* Capabilities.warnDroppedWhen(request.country, {
        provider: "tavily",
        capability: "country",
        field: "country",
        reason:
          "Tavily expects a full country name, not an ISO alpha-2 code; pass it via the typed request if needed.",
      })
      // - `time_range` has no sub-day granularity, so `recency: "hour"` is dropped.
      if (request.recency === "hour") {
        yield* Capabilities.warnDropped({
          provider: "tavily",
          capability: "recency",
          field: "recency",
          value: "hour",
          reason: "Tavily `time_range` has no hour granularity; the smallest window is one day.",
        })
      }
      const wire = yield* postSearch(cfg, buildBody(request))
      return toResponse(wire)
    })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `TavilySearchService` value. For Layer-based setup, prefer
 * {@link layer}.
 */
export const make = (
  cfg: Config,
): Effect.Effect<TavilySearchService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    search: (request) =>
      searchImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering both the provider-typed `TavilySearch` tag and the
 * generic `WebSearch` tag over one implementation. A `CommonSearchRequest`
 * is structurally a `TavilySearchRequest` with the provider extras unset,
 * so the generic registration forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<TavilySearch | WebSearch, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(TavilySearch, make(cfg))
  const generic = Layer.effect(
    WebSearch,
    Effect.map(make(cfg), (s): WebSearchService => ({ search: (request) => s.search(request) })),
  )
  return Layer.merge(typed, generic)
}
