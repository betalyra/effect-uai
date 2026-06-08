import { Context, DateTime, type Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import {
  type CommonSearchRequest,
  type SearchRecency,
  type SearchResponse,
  type SearchResult,
  WebSearch,
  type WebSearchService,
} from "@effect-uai/core/WebSearch"
import type { ExaCategory, ExaSearchType } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Exa-typed search request. Widens {@link CommonSearchRequest} with Exa's
 * own knobs; the common fields map onto Exa's wire filters (see the codec
 * below). There is no `model` - `/search` ranks the web directly, with
 * `type` choosing the retrieval strategy.
 */
export type ExaSearchRequest = CommonSearchRequest & {
  /** Retrieval strategy - see {@link ExaSearchType}. Defaults to `auto`. */
  readonly type?: ExaSearchType
  /** Content-vertical filter - see {@link ExaCategory}. */
  readonly category?: ExaCategory
}

export type ExaSearchService = {
  readonly search: (request: ExaSearchRequest) => Effect.Effect<SearchResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Exa-typed search (`type`,
 * `category`, the per-result `score`); yield the generic `WebSearch` tag
 * for provider-portable code. Both are registered by {@link layer}.
 */
export class ExaSearch extends Context.Service<ExaSearch, ExaSearchService>()(
  "@betalyra/effect-uai/providers/exa/ExaSearch",
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
  readonly numResults?: number
  readonly type?: string
  readonly category?: string
  readonly includeDomains?: ReadonlyArray<string>
  readonly excludeDomains?: ReadonlyArray<string>
  readonly startPublishedDate?: string
  readonly endPublishedDate?: string
  readonly userLocation?: string
}

// Exa has no recency enum; map the coarse enum onto a published-after date
// computed from "now" (per the capabilities policy: lossless translation).
const recencyDuration: Record<SearchRecency, Duration.Input> = {
  hour: "1 hour",
  day: "1 day",
  week: "7 days",
  month: "30 days",
  year: "365 days",
}

const buildBody = (request: ExaSearchRequest, now: DateTime.DateTime): WireBody => {
  // Explicit `startDate` wins over the `recency` sugar; otherwise derive the
  // published-after bound from the recency window.
  const startPublishedDate =
    request.startDate !== undefined
      ? DateTime.formatIso(request.startDate)
      : request.recency !== undefined
        ? DateTime.formatIso(DateTime.subtractDuration(now, recencyDuration[request.recency]))
        : undefined

  return {
    query: request.query,
    ...(request.maxResults !== undefined && { numResults: request.maxResults }),
    ...(request.type !== undefined && { type: request.type }),
    ...(request.category !== undefined && { category: request.category }),
    ...(request.includeDomains !== undefined && { includeDomains: request.includeDomains }),
    ...(request.excludeDomains !== undefined && { excludeDomains: request.excludeDomains }),
    ...(startPublishedDate !== undefined && { startPublishedDate }),
    ...(request.endDate !== undefined && { endPublishedDate: DateTime.formatIso(request.endDate) }),
    ...(request.country !== undefined && { userLocation: request.country }),
  }
}

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireResult = Schema.Struct({
  id: Schema.optional(Schema.String),
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  score: Schema.optional(Schema.Number),
  publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.String)),
})
type WireResult = typeof WireResult.Type

const WireCost = Schema.Struct({
  total: Schema.optional(Schema.Number),
})

const WireResponse = Schema.Struct({
  requestId: Schema.optional(Schema.String),
  results: Schema.Array(WireResult),
  costDollars: Schema.optional(WireCost),
})
type WireResponse = typeof WireResponse.Type

/** Lenient parse of Exa's ISO date strings; unparseable -> omitted. */
const parseDate = (s: string | null | undefined): DateTime.DateTime | undefined =>
  s == null ? undefined : Option.getOrUndefined(DateTime.make(s))

// Exa's pure `/search` returns no text excerpt unless you request `contents`
// (the out-of-scope extract feature), so `snippet` stays undefined here -
// the honest result is url + title + score + publishedDate. `author` and
// the full `raw` object remain on `raw` for typed-tag callers.
const toResult = (r: WireResult): SearchResult => {
  const publishedDate = parseDate(r.publishedDate)
  return {
    url: r.url,
    ...(r.title != null && { title: r.title }),
    ...(r.score !== undefined && { score: r.score }),
    ...(publishedDate !== undefined && { publishedDate }),
    raw: r,
  }
}

const toResponse = (wire: WireResponse): SearchResponse => ({
  results: wire.results.map(toResult),
  ...(wire.costDollars?.total !== undefined && {
    usage: { costUsd: wire.costDollars.total },
  }),
  raw: wire,
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "exa", raw: cause })

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "exa"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.exa.ai"

const postSearch = (
  cfg: Config,
  body: WireBody,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/search`).pipe(
      HttpClientRequest.setHeader("x-api-key", Redacted.value(cfg.apiKey)),
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
    request: ExaSearchRequest,
  ): Effect.Effect<SearchResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      // Exa has no language filter (bucket 2: warn, don't fail).
      yield* Capabilities.warnDroppedWhen(request.language, {
        provider: "exa",
        capability: "language",
        field: "language",
        reason: "Exa /search has no language filter; the hint is ignored.",
      })
      const now = yield* DateTime.now
      const wire = yield* postSearch(cfg, buildBody(request, now))
      return toResponse(wire)
    })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build an `ExaSearchService` value. For Layer-based setup, prefer
 * {@link layer}.
 */
export const make = (cfg: Config): Effect.Effect<ExaSearchService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    search: (request) =>
      searchImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering both the provider-typed `ExaSearch` tag and the
 * generic `WebSearch` tag over one implementation. A `CommonSearchRequest`
 * is structurally an `ExaSearchRequest` with `type` / `category` unset, so
 * the generic registration forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<ExaSearch | WebSearch, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(ExaSearch, make(cfg))
  const generic = Layer.effect(
    WebSearch,
    Effect.map(make(cfg), (s): WebSearchService => ({ search: (request) => s.search(request) })),
  )
  return Layer.merge(typed, generic)
}
