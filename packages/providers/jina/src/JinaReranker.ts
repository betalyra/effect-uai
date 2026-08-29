import { Context, Effect, Encoding, Layer, Match, type Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { ImageSource } from "@effect-uai/core/Image"
import {
  type CommonRerankRequest,
  Reranker,
  type RerankerService,
  type RerankResponse,
  type RerankUsage,
} from "@effect-uai/core/Reranker"
import type { JinaRerankerModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A candidate document. Text models take strings; `jina-reranker-m0` also
 * takes `{ text }` / `{ image }`. One entry is one modality, and image
 * *queries* are local-inference only, so `query` stays a string.
 */
export type JinaRerankDocument =
  | string
  | { readonly text: string }
  | { readonly image: ImageSource }

/** Widens {@link CommonRerankRequest} with Jina's multimodal documents. */
export type JinaRerankRequest = Omit<CommonRerankRequest, "model" | "documents"> & {
  readonly model: JinaRerankerModel
  readonly documents: ReadonlyArray<JinaRerankDocument>
}

export type JinaRerankerService = {
  readonly rerank: (request: JinaRerankRequest) => Effect.Effect<RerankResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for multimodal documents; yield the
 * generic `Reranker` tag for provider-portable code. Both are registered by
 * {@link layer}.
 */
export class JinaReranker extends Context.Service<JinaReranker, JinaRerankerService>()(
  "@betalyra/effect-uai/providers/jina/JinaReranker",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

type WireDocument = string | { readonly text: string } | { readonly image: string }

// Jina detects URL vs base64 from the value itself, so both go in `image`.
const imageSourceToWire: (s: ImageSource) => WireDocument = Match.type<ImageSource>().pipe(
  Match.tag("url", (s): WireDocument => ({ image: s.url })),
  Match.tag("base64", (s): WireDocument => ({ image: s.base64 })),
  Match.tag("bytes", (s): WireDocument => ({ image: Encoding.encodeBase64(s.bytes) })),
  Match.exhaustive,
)

const documentToWire: (doc: JinaRerankDocument) => WireDocument =
  Match.type<JinaRerankDocument>().pipe(
    Match.when(Match.string, (s): WireDocument => s),
    Match.when({ text: Match.string }, ({ text }): WireDocument => ({ text })),
    Match.when({ image: Match.any }, ({ image }) => imageSourceToWire(image)),
    Match.exhaustive,
  )

type WireBody = {
  readonly model: string
  readonly query: string
  readonly documents: ReadonlyArray<WireDocument>
  readonly top_n?: number
}

// No `return_documents`: the caller holds `documents` and `results[].index`
// points back into it.
const buildBody = (request: JinaRerankRequest): WireBody => ({
  model: request.model,
  query: request.query,
  documents: request.documents.map(documentToWire),
  ...(request.topN !== undefined && { top_n: request.topN }),
})

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireResult = Schema.Struct({
  index: Schema.Number,
  relevance_score: Schema.Number,
})

const WireUsage = Schema.Struct({
  total_tokens: Schema.optional(Schema.Number),
})
type WireUsage = typeof WireUsage.Type

const WireResponse = Schema.Struct({
  model: Schema.optional(Schema.String),
  usage: Schema.optional(WireUsage),
  results: Schema.Array(WireResult),
})
type WireResponse = typeof WireResponse.Type

const usageOf = (usage: WireUsage | undefined): RerankUsage =>
  usage?.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}

// Sort rather than trust wire order: the score contract promises descending.
const toResponse = (wire: WireResponse): RerankResponse => ({
  results: [...wire.results]
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .map((r) => ({ index: r.index, score: r.relevance_score })),
  usage: usageOf(wire.usage),
})

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
  if (status === 413) return new AiError.ContextLengthExceeded({ provider, raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.jina.ai/v1"

const postRerank = (
  cfg: Config,
  body: WireBody,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/rerank`).pipe(
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

const rerankImpl =
  (cfg: Config) =>
  (
    request: JinaRerankRequest,
  ): Effect.Effect<RerankResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.map(postRerank(cfg, buildBody(request)), toResponse)

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `JinaRerankerService` value. For Layer-based setup, prefer
 * {@link layer}.
 */
export const make = (
  cfg: Config,
): Effect.Effect<JinaRerankerService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => ({
    rerank: (request) =>
      rerankImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering both the provider-typed `JinaReranker` tag and the generic
 * `Reranker` tag over one implementation. A `CommonRerankRequest` is
 * structurally a `JinaRerankRequest` with string documents, so the generic
 * registration forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<JinaReranker | Reranker, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(JinaReranker, make(cfg))
  const generic = Layer.effect(
    Reranker,
    Effect.map(make(cfg), (s): RerankerService => ({ rerank: (request) => s.rerank(request) })),
  )
  return Layer.merge(typed, generic)
}
