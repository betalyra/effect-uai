import { Context, Effect, Encoding, Layer, Match, Redacted, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { Embedding, EmbedContentPart, EmbedInput, Usage } from "@effect-uai/core/Embedding"
import {
  type CommonEmbedManyRequest,
  type CommonEmbedRequest,
  EmbeddingModel,
  type EmbeddingModelService,
  type EmbedManyResponse,
  type EmbedResponse,
} from "@effect-uai/core/EmbeddingModel"
import type { ImageSource } from "@effect-uai/core/Image"
import type { GoogleEmbeddingModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Gemini's task-type enum, exposed under our friendly names. Mapped to the
 * wire `taskType` values inside the codec. Honoured by
 * `gemini-embedding-001`; ignored by `gemini-embedding-2` (which expects
 * task instructions in the prompt text instead).
 */
export type GoogleEmbeddingTask =
  | "query"
  | "document"
  | "similarity"
  | "classification"
  | "clustering"
  | "qa"
  | "fact_verification"
  | "code_query"

export interface GeminiEmbedRequest
  extends Omit<CommonEmbedRequest, "model" | "task" | "encoding"> {
  /** Narrows `CommonEmbedRequest.model` to the typed Google union. */
  readonly model: GoogleEmbeddingModel
  /**
   * Widens the cross-provider `"query" | "document"` to the full Google
   * task enum. Optional. Honoured by `gemini-embedding-001`; ignored by
   * `gemini-embedding-2`.
   */
  readonly task?: GoogleEmbeddingTask
  /**
   * Optional document title. Only meaningful for `RETRIEVAL_DOCUMENT`
   * tasks on `gemini-embedding-001`.
   */
  readonly title?: string
}

export interface GeminiEmbedManyRequest extends Omit<GeminiEmbedRequest, "input"> {
  readonly inputs: ReadonlyArray<EmbedInput>
}

export interface GeminiEmbeddingService {
  readonly embed: (request: GeminiEmbedRequest) => Effect.Effect<EmbedResponse, AiError.AiError>
  readonly embedMany: (
    request: GeminiEmbedManyRequest,
  ) => Effect.Effect<EmbedManyResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this when you want Gemini-specific
 * options (full `task` enum, `title`); yield the generic `EmbeddingModel`
 * tag for provider-portable code. Both are registered by `layer`.
 */
export class GeminiEmbedding extends Context.Service<GeminiEmbedding, GeminiEmbeddingService>()(
  "@betalyra/effect-uai/providers/google/GeminiEmbedding",
) {}

export interface Config {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

const taskToWire: Record<GoogleEmbeddingTask, string> = {
  query: "RETRIEVAL_QUERY",
  document: "RETRIEVAL_DOCUMENT",
  similarity: "SEMANTIC_SIMILARITY",
  classification: "CLASSIFICATION",
  clustering: "CLUSTERING",
  qa: "QUESTION_ANSWERING",
  fact_verification: "FACT_VERIFICATION",
  code_query: "CODE_RETRIEVAL_QUERY",
}

interface WireTextPart {
  readonly text: string
}
interface WireInlineDataPart {
  readonly inlineData: { readonly mimeType: string; readonly data: string }
}
type WirePart = WireTextPart | WireInlineDataPart
interface WireContent {
  readonly parts: ReadonlyArray<WirePart>
}

const urlRejected = (param: string): AiError.AiError =>
  new AiError.InvalidRequest({
    provider: "gemini",
    param,
    raw: "URL-form image inputs aren't supported; pass base64 or bytes",
  })

/**
 * Pre-uploading via Google's Files API isn't free, so we reject `url`
 * sources up front rather than silently dropping them. Users with HTTPS
 * URLs should fetch + pass `bytes` (or `base64`).
 */
const imageSourceToPart = (param: string) =>
  Match.type<ImageSource>().pipe(
    Match.tag(
      "base64",
      (s): Effect.Effect<WirePart, AiError.AiError> =>
        Effect.succeed({ inlineData: { mimeType: s.mimeType, data: s.base64 } }),
    ),
    Match.tag(
      "bytes",
      (s): Effect.Effect<WirePart, AiError.AiError> =>
        Effect.succeed({
          inlineData: { mimeType: s.mimeType, data: Encoding.encodeBase64(s.bytes) },
        }),
    ),
    Match.tag("url", (): Effect.Effect<WirePart, AiError.AiError> => Effect.fail(urlRejected(param))),
    Match.exhaustive,
  )

const contentPartToPart = (
  param: string,
  part: EmbedContentPart,
): Effect.Effect<WirePart, AiError.AiError> =>
  "text" in part ? Effect.succeed({ text: part.text }) : imageSourceToPart(param)(part.image)

const inputToContent = (input: EmbedInput): Effect.Effect<WireContent, AiError.AiError> => {
  if (typeof input === "string") return Effect.succeed({ parts: [{ text: input }] })
  if ("text" in input) return Effect.succeed({ parts: [{ text: input.text }] })
  if ("image" in input) {
    return imageSourceToPart("input.image")(input.image).pipe(
      Effect.map((part) => ({ parts: [part] })),
    )
  }
  return Effect.forEach(input.content, (p) => contentPartToPart("input.content[].image", p)).pipe(
    Effect.map((parts) => ({ parts })),
  )
}

interface WireSingleBody {
  readonly content: WireContent
  readonly taskType?: string
  readonly outputDimensionality?: number
  readonly title?: string
}

const wireOptions = (
  request: Pick<GeminiEmbedRequest, "task" | "dimensions" | "title">,
): Omit<WireSingleBody, "content"> => ({
  ...(request.task !== undefined && { taskType: taskToWire[request.task] }),
  ...(request.dimensions !== undefined && { outputDimensionality: request.dimensions }),
  ...(request.title !== undefined && { title: request.title }),
})

const buildSingleBody = (
  request: GeminiEmbedRequest,
): Effect.Effect<WireSingleBody, AiError.AiError> =>
  inputToContent(request.input).pipe(
    Effect.map((content) => ({ content, ...wireOptions(request) })),
  )

interface WireBatchEntry extends WireSingleBody {
  readonly model: string
}
interface WireBatchBody {
  readonly requests: ReadonlyArray<WireBatchEntry>
}

const buildBatchBody = (
  request: GeminiEmbedManyRequest,
): Effect.Effect<WireBatchBody, AiError.AiError> => {
  const modelPath = `models/${request.model}`
  const options = wireOptions(request)
  return Effect.forEach(request.inputs, (input) =>
    inputToContent(input).pipe(
      Effect.map((content): WireBatchEntry => ({ model: modelPath, content, ...options })),
    ),
  ).pipe(Effect.map((requests) => ({ requests })))
}

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireEmbedding = Schema.Struct({
  values: Schema.Array(Schema.Number),
})

const WireSingleResponse = Schema.Struct({
  embedding: WireEmbedding,
})

const WireBatchResponse = Schema.Struct({
  embeddings: Schema.Array(WireEmbedding),
})

const valuesToEmbedding = (values: ReadonlyArray<number>): Embedding => ({
  _tag: "float32",
  vector: Float32Array.from(values),
})

// Gemini's embed endpoints don't return token-count metadata. Estimating
// client-side would be provider-specific cruft; honest `undefined` is better.
const emptyUsage: Usage = {}

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "gemini"
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

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "gemini", raw: cause })

// ---------------------------------------------------------------------------
// HTTP plumbing - send a JSON body, error-map status, return parsed JSON.
// ---------------------------------------------------------------------------

const postJson = (
  cfg: Config,
  url: string,
  body: unknown,
): Effect.Effect<unknown, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(httpStatusError(response.status, text))
    }
    return yield* response.json.pipe(Effect.mapError(transportFailure))
  })

const decodeSingle = (json: unknown) =>
  Schema.decodeUnknownEffect(WireSingleResponse)(json).pipe(Effect.mapError(transportFailure))

const decodeBatch = (json: unknown) =>
  Schema.decodeUnknownEffect(WireBatchResponse)(json).pipe(Effect.mapError(transportFailure))

const baseUrl = (cfg: Config): string =>
  cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const embedImpl = (cfg: Config) => (
  request: GeminiEmbedRequest,
): Effect.Effect<EmbedResponse, AiError.AiError, HttpClient.HttpClient> =>
  buildSingleBody(request).pipe(
    Effect.flatMap((body) =>
      postJson(cfg, `${baseUrl(cfg)}/models/${request.model}:embedContent`, body),
    ),
    Effect.flatMap(decodeSingle),
    Effect.map(
      (decoded): EmbedResponse => ({
        embedding: valuesToEmbedding(decoded.embedding.values),
        usage: emptyUsage,
      }),
    ),
  )

const embedManyImpl = (cfg: Config) => (
  request: GeminiEmbedManyRequest,
): Effect.Effect<EmbedManyResponse, AiError.AiError, HttpClient.HttpClient> =>
  buildBatchBody(request).pipe(
    Effect.flatMap((body) =>
      postJson(cfg, `${baseUrl(cfg)}/models/${request.model}:batchEmbedContents`, body),
    ),
    Effect.flatMap(decodeBatch),
    Effect.map(
      (decoded): EmbedManyResponse => ({
        embeddings: decoded.embeddings.map((e) => valuesToEmbedding(e.values)),
        usage: emptyUsage,
      }),
    ),
  )

// Used by the generic `EmbeddingModel` registration. Gemini only returns
// float32 vectors; reject `int8` / `binary` requests up front so callers
// get an actionable error instead of silently-wrong data.
const guardEncoding = <R extends { readonly encoding?: "float32" | "int8" | "binary" }>(
  req: R,
): Effect.Effect<R, AiError.AiError> =>
  req.encoding === undefined || req.encoding === "float32"
    ? Effect.succeed(req)
    : Effect.fail(
        new AiError.InvalidRequest({
          provider: "gemini",
          param: "encoding",
          raw: `Gemini only returns float32 vectors; got encoding="${req.encoding}"`,
        }),
      )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `GeminiEmbeddingService` value. For Layer-based setup, prefer
 * `layer`.
 */
export const make = (
  cfg: Config,
): Effect.Effect<GeminiEmbeddingService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    embed: (request) =>
      embedImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    embedMany: (request) =>
      embedManyImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer that registers both the provider-specific `GeminiEmbedding` tag
 * and the generic `EmbeddingModel` tag, sharing one underlying
 * implementation.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<GeminiEmbedding | EmbeddingModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(GeminiEmbedding, make(cfg))
  const generic = Layer.effect(
    EmbeddingModel,
    Effect.map(
      make(cfg),
      (s): EmbeddingModelService => ({
        embed: (req: CommonEmbedRequest) =>
          pipe(
            guardEncoding(req),
            Effect.flatMap(() => s.embed(req as GeminiEmbedRequest)),
          ),
        embedMany: (req: CommonEmbedManyRequest) =>
          pipe(
            guardEncoding(req),
            Effect.flatMap(() => s.embedMany(req as GeminiEmbedManyRequest)),
          ),
      }),
    ),
  )
  return Layer.merge(typed, generic)
}
