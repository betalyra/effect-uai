import { Context, Duration, Effect, Layer, type Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import {
  type CommonReadRequest,
  type ReadResponse,
  WebRead,
  type WebReadService,
} from "@effect-uai/core/WebRead"
import type { JinaEngine } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Jina-typed read request. Widens {@link CommonReadRequest} with Jina
 * Reader's own header knobs; the common fields map onto Reader headers (see
 * the codec below).
 */
export type JinaReadRequest = CommonReadRequest & {
  /** Fetching engine - see {@link JinaEngine}. */
  readonly engine?: JinaEngine
  /** CSS selector to extract instead of the whole page (`X-Target-Selector`). */
  readonly targetSelector?: string
  /** Bypass Jina's page cache (`X-No-Cache`). */
  readonly noCache?: boolean
  /** Append a deduplicated link list, populating {@link ReadResponse.links}. */
  readonly withLinksSummary?: boolean
}

export type JinaReaderService = {
  readonly read: (request: JinaReadRequest) => Effect.Effect<ReadResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Jina-typed reads (its own
 * Reader headers); yield the generic `WebRead` tag for provider-portable
 * code. Both are registered by {@link layer}.
 */
export class JinaReader extends Context.Service<JinaReader, JinaReaderService>()(
  "@betalyra/effect-uai/providers/jina/JinaReader",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request headers
// ---------------------------------------------------------------------------

// Reader is header-driven: the URL is the path, everything else is a header.
// `markdown` / `html` map one-to-one onto `X-Return-Format`.
const buildHeaders = (request: JinaReadRequest): Record<string, string> => {
  const format = request.format ?? "markdown"
  return {
    Accept: "application/json",
    "X-Return-Format": format,
    ...(request.timeout !== undefined && {
      // `X-Timeout` is whole seconds, capped at 180 by Jina.
      "X-Timeout": String(Math.max(1, Math.round(Duration.toMillis(request.timeout) / 1000))),
    }),
    ...(request.engine !== undefined && { "X-Engine": request.engine }),
    ...(request.targetSelector !== undefined && { "X-Target-Selector": request.targetSelector }),
    ...(request.noCache === true && { "X-No-Cache": "true" }),
    ...(request.withLinksSummary === true && { "X-With-Links-Summary": "true" }),
  }
}

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireData = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  // `content` carries markdown/text; `html` carries html. Exactly one is set,
  // depending on the requested format.
  content: Schema.optional(Schema.NullOr(Schema.String)),
  html: Schema.optional(Schema.NullOr(Schema.String)),
  // Present only with `X-With-Links-Summary`; a { anchorText: url } record.
  links: Schema.optional(Schema.Unknown),
})

const WireResponse = Schema.Struct({
  code: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.Number),
  data: WireData,
})
type WireResponse = typeof WireResponse.Type

// Jina reports links as a { text: url } record; take the URLs. Tolerate an
// array shape too, and omit when empty.
const extractLinks = (links: unknown): ReadonlyArray<string> | undefined => {
  const values = Array.isArray(links)
    ? links
    : links !== null && typeof links === "object"
      ? Object.values(links as Record<string, unknown>)
      : []
  const urls = values.filter((v): v is string => typeof v === "string")
  return urls.length > 0 ? urls : undefined
}

const toResponse = (wire: WireResponse, request: JinaReadRequest): ReadResponse => {
  const { data } = wire
  const format = request.format ?? "markdown"
  const content = (format === "html" ? data.html : data.content) ?? ""
  const title = data.title ?? undefined
  const links = extractLinks(data.links)
  return {
    url: data.url ?? request.url,
    content,
    ...(title !== undefined && { title }),
    ...(links !== undefined && { links }),
    raw: wire,
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "jina", raw: cause })

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "jina"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://r.jina.ai"

const getRead = (
  cfg: Config,
  request: JinaReadRequest,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    // The target URL is appended as the path: `https://r.jina.ai/<url>`.
    const httpRequest = HttpClientRequest.get(`${baseUrl(cfg)}/${request.url}`).pipe(
      HttpClientRequest.bearerToken(cfg.apiKey),
      HttpClientRequest.setHeaders(buildHeaders(request)),
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
  (request: JinaReadRequest): Effect.Effect<ReadResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.map(getRead(cfg, request), (wire) => toResponse(wire, request))

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `JinaReaderService` value. For Layer-based setup, prefer
 * {@link layer}.
 */
export const make = (cfg: Config): Effect.Effect<JinaReaderService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    read: (request) =>
      readImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering both the provider-typed `JinaReader` tag and the generic
 * `WebRead` tag over one implementation. A `CommonReadRequest` is
 * structurally a `JinaReadRequest` with the extra knobs unset, so the generic
 * registration forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<JinaReader | WebRead, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(JinaReader, make(cfg))
  const generic = Layer.effect(
    WebRead,
    Effect.map(make(cfg), (s): WebReadService => ({ read: (request) => s.read(request) })),
  )
  return Layer.merge(typed, generic)
}
