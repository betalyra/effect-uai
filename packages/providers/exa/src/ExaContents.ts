import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import {
  type CommonReadRequest,
  type ReadResponse,
  WebRead,
  type WebReadService,
} from "@effect-uai/core/WebRead"
import type { ExaLivecrawl } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Exa-typed read request. Widens {@link CommonReadRequest} with Exa
 * `/contents` knobs; the common fields map onto Exa's wire body (see the
 * codec below).
 */
export type ExaContentsRequest = CommonReadRequest & {
  /** Freshness / cache policy - see {@link ExaLivecrawl}. */
  readonly livecrawl?: ExaLivecrawl
  /** Cap on the returned content length (Exa `text.maxCharacters`). */
  readonly maxCharacters?: number
}

export type ExaContentsService = {
  readonly read: (request: ExaContentsRequest) => Effect.Effect<ReadResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Exa-typed reads (its own
 * `/contents` knobs); yield the generic `WebRead` tag for provider-portable
 * code. Both are registered by {@link layer}.
 */
export class ExaContents extends Context.Service<ExaContents, ExaContentsService>()(
  "@betalyra/effect-uai/providers/exa/ExaContents",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

type WireText = {
  readonly maxCharacters?: number
  readonly includeHtmlTags?: boolean
}

type WireBody = {
  readonly urls: ReadonlyArray<string>
  readonly text: WireText
  readonly livecrawl?: string
}

// Exa returns markdown by default; `includeHtmlTags: true` returns HTML tags
// instead. Both land on the single `text` field of the result.
const buildBody = (request: ExaContentsRequest): WireBody => {
  const text: WireText = {
    ...(request.maxCharacters !== undefined && { maxCharacters: request.maxCharacters }),
    ...(request.format === "html" && { includeHtmlTags: true }),
  }
  return {
    urls: [request.url],
    text,
    ...(request.livecrawl !== undefined && { livecrawl: request.livecrawl }),
  }
}

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireResult = Schema.Struct({
  id: Schema.optional(Schema.String),
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
})
type WireResult = typeof WireResult.Type

const WireStatus = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
})

const WireResponse = Schema.Struct({
  requestId: Schema.optional(Schema.String),
  results: Schema.Array(WireResult),
  statuses: Schema.optional(Schema.Array(WireStatus)),
})
type WireResponse = typeof WireResponse.Type

const toResponse = (wire: WireResponse, result: WireResult): ReadResponse => {
  const title = result.title ?? undefined
  return {
    url: result.url,
    content: result.text ?? "",
    ...(title !== undefined && { title }),
    raw: wire,
  }
}

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

const postContents = (
  cfg: Config,
  body: WireBody,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/contents`).pipe(
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

const readImpl =
  (cfg: Config) =>
  (
    request: ExaContentsRequest,
  ): Effect.Effect<ReadResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const wire = yield* postContents(cfg, buildBody(request))
      // Exa reports per-URL crawl failures in `results` / `statuses` rather
      // than an HTTP error; a missing first result means the single URL could
      // not be read.
      const result = wire.results[0]
      if (result === undefined) {
        return yield* new AiError.Unavailable({ provider: "exa", raw: wire })
      }
      return toResponse(wire, result)
    })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build an `ExaContentsService` value. For Layer-based setup, prefer
 * {@link layer}.
 */
export const make = (
  cfg: Config,
): Effect.Effect<ExaContentsService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    read: (request) =>
      readImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering both the provider-typed `ExaContents` tag and the generic
 * `WebRead` tag over one implementation. A `CommonReadRequest` is structurally
 * an `ExaContentsRequest` with the extra knobs unset, so the generic
 * registration forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<ExaContents | WebRead, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(ExaContents, make(cfg))
  const generic = Layer.effect(
    WebRead,
    Effect.map(make(cfg), (s): WebReadService => ({ read: (request) => s.read(request) })),
  )
  return Layer.merge(typed, generic)
}
