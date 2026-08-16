import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import {
  type CommonReadRequest,
  type ReadResponse,
  WebRead,
  type WebReadService,
} from "@effect-uai/core/WebRead"
import type { FirecrawlProxy } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Firecrawl-typed read request. Widens {@link CommonReadRequest} with
 * Firecrawl's own scrape knobs; the common fields map onto Firecrawl's wire
 * body (see the codec below).
 */
export type FirecrawlReadRequest = CommonReadRequest & {
  /** Keep only the main content, dropping nav/header/footer/sidebar. */
  readonly onlyMainContent?: boolean
  /** Restrict extraction to these HTML tags / selectors. */
  readonly includeTags?: ReadonlyArray<string>
  /** Drop these HTML tags / selectors before extraction. */
  readonly excludeTags?: ReadonlyArray<string>
  /** Wait this long for the page to settle before scraping (JS-heavy sites). */
  readonly waitFor?: Duration.Duration
  /** Emulate a mobile device. */
  readonly mobile?: boolean
  /** Proxy tier - see {@link FirecrawlProxy}. */
  readonly proxy?: FirecrawlProxy
}

/**
 * Firecrawl-typed map (sitemap / URL discovery) request. Given a base `url`,
 * Firecrawl returns the site's URLs without scraping each one - handy for
 * locating specific pages (pricing, docs) before a targeted read. All fields
 * but `url` are optional.
 */
export type FirecrawlMapRequest = {
  readonly url: string
  /** Order results by relevance to this query. */
  readonly search?: string
  /** Cap the number of links returned. */
  readonly limit?: number
  /** How to use the site's sitemap: `only` (sitemap alone), `include`, or `skip`. */
  readonly sitemap?: "only" | "include" | "skip"
  /** Include links on subdomains of the base URL. */
  readonly includeSubdomains?: boolean
  /** Abort the map if it runs past this duration. */
  readonly timeout?: Duration.Duration
}

/** One discovered URL, with page metadata where Firecrawl has it. */
export type MapLink = {
  readonly url: string
  readonly title?: string
  readonly description?: string
}

export type MapResponse = {
  readonly links: ReadonlyArray<MapLink>
  readonly raw: unknown
}

export type FirecrawlReadService = {
  readonly read: (request: FirecrawlReadRequest) => Effect.Effect<ReadResponse, AiError.AiError>
  /**
   * Discover a site's URLs (sitemap-style) without scraping. Firecrawl-specific;
   * not on the generic `WebRead` tag, whose contract is a single-URL read.
   */
  readonly map: (request: FirecrawlMapRequest) => Effect.Effect<MapResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Firecrawl-typed reads (its own
 * scrape knobs); yield the generic `WebRead` tag for provider-portable code.
 * Both are registered by {@link layer}.
 */
export class FirecrawlRead extends Context.Service<FirecrawlRead, FirecrawlReadService>()(
  "@betalyra/effect-uai/providers/firecrawl/FirecrawlRead",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

type WireBody = {
  readonly url: string
  readonly formats: ReadonlyArray<string>
  readonly onlyMainContent?: boolean
  readonly includeTags?: ReadonlyArray<string>
  readonly excludeTags?: ReadonlyArray<string>
  readonly waitFor?: number
  readonly timeout?: number
  readonly mobile?: boolean
  readonly proxy?: string
}

// `markdown` / `html` map one-to-one onto Firecrawl's format names. `links` is
// always requested so {@link ReadResponse.links} can be populated; it does not
// change the per-page billing.
const buildBody = (request: FirecrawlReadRequest): WireBody => {
  const contentFormat = request.format ?? "markdown"
  return {
    url: request.url,
    formats: [contentFormat, "links"],
    ...(request.onlyMainContent !== undefined && { onlyMainContent: request.onlyMainContent }),
    ...(request.includeTags !== undefined && { includeTags: request.includeTags }),
    ...(request.excludeTags !== undefined && { excludeTags: request.excludeTags }),
    ...(request.waitFor !== undefined && { waitFor: Duration.toMillis(request.waitFor) }),
    ...(request.timeout !== undefined && { timeout: Duration.toMillis(request.timeout) }),
    ...(request.mobile !== undefined && { mobile: request.mobile }),
    ...(request.proxy !== undefined && { proxy: request.proxy }),
  }
}

type WireMapBody = {
  readonly url: string
  readonly search?: string
  readonly limit?: number
  readonly sitemap?: string
  readonly includeSubdomains?: boolean
  readonly timeout?: number
}

const buildMapBody = (request: FirecrawlMapRequest): WireMapBody => ({
  url: request.url,
  ...(request.search !== undefined && { search: request.search }),
  ...(request.limit !== undefined && { limit: request.limit }),
  ...(request.sitemap !== undefined && { sitemap: request.sitemap }),
  ...(request.includeSubdomains !== undefined && { includeSubdomains: request.includeSubdomains }),
  ...(request.timeout !== undefined && { timeout: Duration.toMillis(request.timeout) }),
})

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireMetadata = Schema.Struct({
  // Firecrawl returns `title` as a string, an array (repeated meta tags), or
  // null; normalize to a single string in `toResponse`.
  title: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))),
  sourceURL: Schema.optional(Schema.NullOr(Schema.String)),
  statusCode: Schema.optional(Schema.Number),
})

const WireData = Schema.Struct({
  markdown: Schema.optional(Schema.NullOr(Schema.String)),
  html: Schema.optional(Schema.NullOr(Schema.String)),
  rawHtml: Schema.optional(Schema.NullOr(Schema.String)),
  links: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  metadata: Schema.optional(WireMetadata),
})

/**
 * `data` is optional because a failed scrape is not an HTTP failure. Firecrawl
 * answers 200 with `{ success: false, error }` when a page is blocked, times
 * out or renders only under JS — so requiring `data` turned every one of those
 * into a decode error, which was then reported as a transport fault and
 * retried on the backoff schedule.
 */
const WireResponse = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  data: Schema.optional(WireData),
  error: Schema.optional(Schema.NullOr(Schema.String)),
})
type WireResponse = typeof WireResponse.Type

const pickTitle = (title: string | ReadonlyArray<string> | null | undefined): string | undefined =>
  typeof title === "string" ? title : Array.isArray(title) ? title[0] : undefined

const toResponse = (
  wire: WireResponse,
  data: NonNullable<WireResponse["data"]>,
  request: FirecrawlReadRequest,
): ReadResponse => {
  const format = request.format ?? "markdown"
  const content = (format === "html" ? data.html : data.markdown) ?? ""
  const title = pickTitle(data.metadata?.title)
  const links = data.links ?? undefined
  return {
    url: data.metadata?.sourceURL ?? request.url,
    content,
    ...(title !== undefined && { title }),
    ...(links !== undefined && links.length > 0 && { links }),
    raw: wire,
  }
}

// v2 returns link objects; older responses returned bare URL strings. Accept
// both and normalize a string to `{ url }` in `toMapResponse`.
const WireMapLink = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
})

const WireMapResponse = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  links: Schema.Array(Schema.Union([WireMapLink, Schema.String])),
})
type WireMapResponse = typeof WireMapResponse.Type

const toMapLink = (link: typeof WireMapLink.Type | string): MapLink =>
  typeof link === "string"
    ? { url: link }
    : {
        url: link.url,
        ...(link.title != null && { title: link.title }),
        ...(link.description != null && { description: link.description }),
      }

const toMapResponse = (wire: WireMapResponse): MapResponse => ({
  links: wire.links.map(toMapLink),
  raw: wire,
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "firecrawl", raw: cause })

/**
 * The call arrived and the answer is unusable — a scrape Firecrawl itself
 * reports as failed, or a body that does not match what this provider knows how
 * to read.
 *
 * Deliberately not `Unavailable`: that tag is retryable, and neither of these
 * gets better on a second attempt. A blocked page stays blocked while the
 * backoff spends the scrape budget on it, and a changed API shape is a code
 * problem, not a weather problem.
 */
const unusableResponse = (message: string, raw: unknown): AiError.AiError =>
  new AiError.GenerationFailed({ provider: "firecrawl", message, raw })

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "firecrawl"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.firecrawl.dev"

const postScrape = (
  cfg: Config,
  body: WireBody,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/v2/scrape`).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(cfg.apiKey)}`),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    return yield* Schema.decodeUnknownEffect(WireResponse)(json).pipe(
      Effect.mapError((issue) =>
        unusableResponse("firecrawl returned a body this provider cannot read", issue),
      ),
    )
  })

const readImpl =
  (cfg: Config) =>
  (
    request: FirecrawlReadRequest,
  ): Effect.Effect<ReadResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.flatMap(postScrape(cfg, buildBody(request)), (wire) =>
      // A 200 carrying `success: false` is Firecrawl reporting the page could
      // not be scraped — blocked, JS-only, or timed out. Its own message is the
      // useful part, so it becomes the error rather than a decode failure.
      wire.data === undefined || wire.success === false
        ? Effect.fail(
            unusableResponse(wire.error ?? `firecrawl could not scrape ${request.url}`, wire),
          )
        : Effect.succeed(toResponse(wire, wire.data, request)),
    )

const postMap = (
  cfg: Config,
  body: WireMapBody,
): Effect.Effect<WireMapResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/v2/map`).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(cfg.apiKey)}`),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    return yield* Schema.decodeUnknownEffect(WireMapResponse)(json).pipe(
      Effect.mapError(transportFailure),
    )
  })

const mapImpl =
  (cfg: Config) =>
  (
    request: FirecrawlMapRequest,
  ): Effect.Effect<MapResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.map(postMap(cfg, buildMapBody(request)), toMapResponse)

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `FirecrawlReadService` value. For Layer-based setup, prefer
 * {@link layer}.
 */
export const make = (
  cfg: Config,
): Effect.Effect<FirecrawlReadService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => ({
    read: (request) =>
      readImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    map: (request) =>
      mapImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering both the provider-typed `FirecrawlRead` tag and the
 * generic `WebRead` tag over one implementation. A `CommonReadRequest` is
 * structurally a `FirecrawlReadRequest` with the extra knobs unset, so the
 * generic registration forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<FirecrawlRead | WebRead, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(FirecrawlRead, make(cfg))
  const generic = Layer.effect(
    WebRead,
    Effect.map(make(cfg), (s): WebReadService => ({ read: (request) => s.read(request) })),
  )
  return Layer.merge(typed, generic)
}
