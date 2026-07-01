import { Context, Duration, Effect, Layer, type Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import {
  type CommonReadRequest,
  type ReadResponse,
  WebRead,
  type WebReadService,
} from "@effect-uai/core/WebRead"
import type { TavilyExtractDepth } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Tavily-typed read request. Widens {@link CommonReadRequest} with Tavily
 * `/extract` knobs; the common fields map onto Tavily's wire body (see the
 * codec below).
 */
export type TavilyReadRequest = CommonReadRequest & {
  /** Extraction depth - see {@link TavilyExtractDepth}. */
  readonly extractDepth?: TavilyExtractDepth
}

export type TavilyReadService = {
  readonly read: (request: TavilyReadRequest) => Effect.Effect<ReadResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Tavily-typed reads (its own
 * `/extract` knobs); yield the generic `WebRead` tag for provider-portable
 * code. Both are registered by {@link layer}.
 */
export class TavilyRead extends Context.Service<TavilyRead, TavilyReadService>()(
  "@betalyra/effect-uai/providers/tavily/TavilyRead",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

type WireBody = {
  readonly urls: ReadonlyArray<string>
  readonly format: "markdown"
  readonly extract_depth?: string
  readonly timeout?: number
}

// Tavily `/extract` only produces markdown or plain text, so we always request
// markdown; an `html` request is handled by the warn-and-fallback in readImpl.
const buildBody = (request: TavilyReadRequest): WireBody => ({
  urls: [request.url],
  format: "markdown",
  ...(request.extractDepth !== undefined && { extract_depth: request.extractDepth }),
  ...(request.timeout !== undefined && { timeout: Duration.toMillis(request.timeout) / 1000 }),
})

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireResult = Schema.Struct({
  url: Schema.String,
  raw_content: Schema.optional(Schema.NullOr(Schema.String)),
})
type WireResult = typeof WireResult.Type

const WireFailed = Schema.Struct({
  url: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

const WireResponse = Schema.Struct({
  results: Schema.Array(WireResult),
  failed_results: Schema.optional(Schema.Array(WireFailed)),
  request_id: Schema.optional(Schema.String),
})
type WireResponse = typeof WireResponse.Type

const toResponse = (wire: WireResponse, result: WireResult): ReadResponse => ({
  url: result.url,
  content: result.raw_content ?? "",
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

const postExtract = (
  cfg: Config,
  body: WireBody,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/extract`).pipe(
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

const readImpl =
  (cfg: Config) =>
  (
    request: TavilyReadRequest,
  ): Effect.Effect<ReadResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      // Tavily has no HTML output (bucket 2: warn, fall back to markdown).
      yield* Capabilities.warnDroppedWhen(request.format === "html" ? "html" : undefined, {
        provider: "tavily",
        capability: "format",
        field: "format",
        reason: "Tavily /extract returns markdown or text only; html falls back to markdown.",
      })
      const wire = yield* postExtract(cfg, buildBody(request))
      // Tavily reports per-URL failures in `failed_results` rather than an HTTP
      // error; a missing first result means the single URL could not be read.
      const result = wire.results[0]
      if (result === undefined) {
        return yield* new AiError.Unavailable({ provider: "tavily", raw: wire })
      }
      return toResponse(wire, result)
    })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `TavilyReadService` value. For Layer-based setup, prefer
 * {@link layer}.
 */
export const make = (cfg: Config): Effect.Effect<TavilyReadService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    read: (request) =>
      readImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering both the provider-typed `TavilyRead` tag and the generic
 * `WebRead` tag over one implementation. A `CommonReadRequest` is structurally
 * a `TavilyReadRequest` with `extractDepth` unset, so the generic registration
 * forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<TavilyRead | WebRead, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(TavilyRead, make(cfg))
  const generic = Layer.effect(
    WebRead,
    Effect.map(make(cfg), (s): WebReadService => ({ read: (request) => s.read(request) })),
  )
  return Layer.merge(typed, generic)
}
