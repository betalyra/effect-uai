import { Context, DateTime, Effect, Layer, Option, type Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import {
  type CommonSearchRequest,
  type SearchResponse,
  type SearchResult,
  WebSearch,
  type WebSearchService,
} from "@effect-uai/core/WebSearch"
import type { PerplexitySearchContextSize } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Perplexity-typed search request. Widens {@link CommonSearchRequest} with
 * the provider's own knobs; the common fields map onto Perplexity's wire
 * filters (see the codec below). There is no `model` - `/search` ranks the
 * web directly.
 */
export type PerplexitySearchRequest = CommonSearchRequest & {
  /** Depth / cost trade-off - see {@link PerplexitySearchContextSize}. */
  readonly searchContextSize?: PerplexitySearchContextSize
  /** Cap on tokens extracted per result page (1..1_000_000). */
  readonly maxTokensPerPage?: number
}

export type PerplexitySearchService = {
  readonly search: (
    request: PerplexitySearchRequest,
  ) => Effect.Effect<SearchResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Perplexity-typed search
 * (`searchContextSize`, `maxTokensPerPage`); yield the generic `WebSearch`
 * tag for provider-portable code. Both are registered by {@link layer}.
 */
export class PerplexitySearch extends Context.Service<PerplexitySearch, PerplexitySearchService>()(
  "@betalyra/effect-uai/providers/perplexity/PerplexitySearch",
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
  readonly max_results?: number
  readonly country?: string
  readonly search_language_filter?: ReadonlyArray<string>
  readonly search_domain_filter?: ReadonlyArray<string>
  readonly search_recency_filter?: string
  readonly search_after_date_filter?: string
  readonly search_before_date_filter?: string
  readonly search_context_size?: string
  readonly max_tokens_per_page?: number
}

/** Perplexity wants dates as `MM/DD/YYYY`, in UTC. */
const formatMmDdYyyy = (dt: DateTime.DateTime): string => {
  const d = DateTime.toDateUtc(dt)
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  return `${mm}/${dd}/${d.getUTCFullYear()}`
}

/**
 * Perplexity has no separate include / exclude fields - it takes one
 * `search_domain_filter` array where an exclusion is a `-` prefix. Lossless
 * shape transform, so done silently (bucket 3).
 */
const domainFilter = (
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  const all = [...(include ?? []), ...(exclude ?? []).map((d) => `-${d}`)]
  return all.length > 0 ? all : undefined
}

const buildBody = (request: PerplexitySearchRequest): WireBody => {
  const domains = domainFilter(request.includeDomains, request.excludeDomains)
  return {
    query: request.query,
    ...(request.maxResults !== undefined && { max_results: request.maxResults }),
    ...(request.country !== undefined && { country: request.country }),
    ...(request.language !== undefined && { search_language_filter: [request.language] }),
    ...(domains !== undefined && { search_domain_filter: domains }),
    ...(request.recency !== undefined && { search_recency_filter: request.recency }),
    ...(request.startDate !== undefined && {
      search_after_date_filter: formatMmDdYyyy(request.startDate),
    }),
    ...(request.endDate !== undefined && {
      search_before_date_filter: formatMmDdYyyy(request.endDate),
    }),
    ...(request.searchContextSize !== undefined && {
      search_context_size: request.searchContextSize,
    }),
    ...(request.maxTokensPerPage !== undefined && {
      max_tokens_per_page: request.maxTokensPerPage,
    }),
  }
}

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.optional(Schema.String),
  date: Schema.optional(Schema.NullOr(Schema.String)),
  last_updated: Schema.optional(Schema.NullOr(Schema.String)),
})
type WireResult = typeof WireResult.Type

const WireResponse = Schema.Struct({
  results: Schema.Array(WireResult),
  id: Schema.optional(Schema.String),
})
type WireResponse = typeof WireResponse.Type

/** Lenient parse of Perplexity's date strings; unparseable -> omitted. */
const parseDate = (s: string | null | undefined): DateTime.DateTime | undefined =>
  s == null ? undefined : Option.getOrUndefined(DateTime.make(s))

const toResult = (r: WireResult): SearchResult => {
  const publishedDate = parseDate(r.date)
  return {
    url: r.url,
    title: r.title,
    // Perplexity returns no relevance score, so `score` stays undefined.
    ...(r.snippet !== undefined && { snippet: r.snippet }),
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
  new AiError.Unavailable({ provider: "perplexity", raw: cause })

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "perplexity"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.perplexity.ai"

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
    request: PerplexitySearchRequest,
  ): Effect.Effect<SearchResponse, AiError.AiError, HttpClient.HttpClient> =>
    postSearch(cfg, buildBody(request)).pipe(Effect.map(toResponse))

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `PerplexitySearchService` value. For Layer-based setup, prefer
 * {@link layer}.
 */
export const make = (
  cfg: Config,
): Effect.Effect<PerplexitySearchService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    search: (request) =>
      searchImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering both the provider-typed `PerplexitySearch` tag and the
 * generic `WebSearch` tag over one implementation. A `CommonSearchRequest`
 * is structurally a `PerplexitySearchRequest` with the provider extras
 * unset, so the generic registration forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<PerplexitySearch | WebSearch, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(PerplexitySearch, make(cfg))
  const generic = Layer.effect(
    WebSearch,
    Effect.map(make(cfg), (s): WebSearchService => ({ search: (request) => s.search(request) })),
  )
  return Layer.merge(typed, generic)
}
