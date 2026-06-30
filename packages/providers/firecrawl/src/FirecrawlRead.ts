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

export type FirecrawlReadService = {
  readonly read: (request: FirecrawlReadRequest) => Effect.Effect<ReadResponse, AiError.AiError>
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

const WireResponse = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  data: WireData,
})
type WireResponse = typeof WireResponse.Type

const pickTitle = (title: string | ReadonlyArray<string> | null | undefined): string | undefined =>
  typeof title === "string" ? title : Array.isArray(title) ? title[0] : undefined

const toResponse = (wire: WireResponse, request: FirecrawlReadRequest): ReadResponse => {
  const { data } = wire
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

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "firecrawl", raw: cause })

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
      Effect.mapError(transportFailure),
    )
  })

const readImpl =
  (cfg: Config) =>
  (
    request: FirecrawlReadRequest,
  ): Effect.Effect<ReadResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.map(postScrape(cfg, buildBody(request)), (wire) => toResponse(wire, request))

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
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    read: (request) =>
      readImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
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
