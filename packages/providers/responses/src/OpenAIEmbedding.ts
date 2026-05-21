import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type {
  EmbedContentPart,
  EmbedInput,
  Float32Embedding,
  Usage,
} from "@effect-uai/core/Embedding"
import {
  type CommonEmbedManyRequest,
  type CommonEmbedRequest,
  type EmbedEncoding,
  EmbeddingModel,
  type EmbeddingModelService,
  type EmbedManyResponse,
  type EmbedResponse,
} from "@effect-uai/core/EmbeddingModel"
import type { OpenAIEmbeddingModel } from "./models.js"
import { type OpenAiRegion, resolveHost } from "./region.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * OpenAI's embedding API has no task-type semantics, so `task` is omitted
 * from the request type intentionally - passing it would be a compile
 * error. The generic `EmbeddingModel` registration accepts and silently
 * ignores `task` from `CommonEmbedRequest`.
 */
export type OpenAIEmbedRequest = Omit<CommonEmbedRequest, "model" | "task" | "encoding"> & {
  /** Narrows `CommonEmbedRequest.model` to the typed OpenAI union. */
  readonly model: OpenAIEmbeddingModel
}

export type OpenAIEmbedManyRequest = Omit<OpenAIEmbedRequest, "input"> & {
  readonly inputs: ReadonlyArray<EmbedInput>
}

export type OpenAIEmbeddingService = {
  readonly embed: (request: OpenAIEmbedRequest) => Effect.Effect<EmbedResponse, AiError.AiError>
  readonly embedMany: (
    request: OpenAIEmbedManyRequest,
  ) => Effect.Effect<EmbedManyResponse, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for OpenAI-typed embedding
 * requests; yield the generic `EmbeddingModel` tag for provider-portable
 * code. Both are registered by `layer`.
 */
export class OpenAIEmbedding extends Context.Service<OpenAIEmbedding, OpenAIEmbeddingService>()(
  "@betalyra/effect-uai/providers/responses/OpenAIEmbedding",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
}

// ---------------------------------------------------------------------------
// Codec - input flattening to the single string OpenAI expects
// ---------------------------------------------------------------------------

const imageRejected: AiError.AiError = new AiError.Unsupported({
  provider: "openai",
  capability: "imageEmbedding",
  reason: "OpenAI embeddings are text-only; pass a string or { text }.",
})

const partToText = (part: EmbedContentPart): Effect.Effect<string, AiError.AiError> =>
  "text" in part ? Effect.succeed(part.text) : Effect.fail(imageRejected)

/**
 * OpenAI accepts a single string per input. Pure-text `content[]` is
 * concatenated with newlines (treats them as paragraphs of one document);
 * any image part fails with `AiError.Unsupported` (`imageEmbedding`).
 */
const inputToString = (input: EmbedInput): Effect.Effect<string, AiError.AiError> => {
  if (typeof input === "string") return Effect.succeed(input)
  if ("text" in input) return Effect.succeed(input.text)
  if ("image" in input) return Effect.fail(imageRejected)
  return Effect.forEach(input.content, partToText).pipe(
    Effect.map((texts) => texts.join("\n")),
  )
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

type WireBody = {
  readonly model: string
  readonly input: string | ReadonlyArray<string>
  readonly dimensions?: number
  readonly encoding_format?: "float" | "base64"
}

const buildSingleBody = (request: OpenAIEmbedRequest): Effect.Effect<WireBody, AiError.AiError> =>
  inputToString(request.input).pipe(
    Effect.map((input) => ({
      model: request.model,
      input,
      ...(request.dimensions !== undefined && { dimensions: request.dimensions }),
    })),
  )

const buildBatchBody = (
  request: OpenAIEmbedManyRequest,
): Effect.Effect<WireBody, AiError.AiError> =>
  Effect.forEach(request.inputs, inputToString).pipe(
    Effect.map((inputs) => ({
      model: request.model,
      input: inputs,
      ...(request.dimensions !== undefined && { dimensions: request.dimensions }),
    })),
  )

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireEmbeddingItem = Schema.Struct({
  embedding: Schema.Array(Schema.Number),
  index: Schema.Number,
})

const WireUsage = Schema.Struct({
  prompt_tokens: Schema.Number,
  total_tokens: Schema.Number,
})

const WireResponse = Schema.Struct({
  data: Schema.Array(WireEmbeddingItem),
  model: Schema.String,
  usage: WireUsage,
})

const valuesToEmbedding = (values: ReadonlyArray<number>): Float32Embedding => ({
  _tag: "float32",
  vector: Float32Array.from(values),
})

// OpenAI returns `data[]` unsorted in theory; sort by `index` so caller
// gets results in the order they passed inputs.
const orderedEmbeddings = (
  data: ReadonlyArray<{ readonly embedding: ReadonlyArray<number>; readonly index: number }>,
): ReadonlyArray<Float32Embedding> =>
  [...data].sort((a, b) => a.index - b.index).map((item) => valuesToEmbedding(item.embedding))

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "openai"
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
  new AiError.Unavailable({ provider: "openai", raw: cause })

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const postEmbed = (
  cfg: Config,
  body: WireBody,
): Effect.Effect<typeof WireResponse.Type, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${resolveHost(cfg)}/embeddings`).pipe(
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

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const usageOf = (u: typeof WireUsage.Type): Usage => ({ inputTokens: u.prompt_tokens })

const embedImpl =
  (cfg: Config) =>
  (
    request: OpenAIEmbedRequest,
  ): Effect.Effect<EmbedResponse, AiError.AiError, HttpClient.HttpClient> =>
    buildSingleBody(request).pipe(
      Effect.flatMap((body) => postEmbed(cfg, body)),
      Effect.flatMap((decoded) => {
        const first = decoded.data[0]
        if (first === undefined) {
          return Effect.fail(transportFailure("OpenAI returned empty `data` array"))
        }
        return Effect.succeed<EmbedResponse>({
          embedding: valuesToEmbedding(first.embedding),
          usage: usageOf(decoded.usage),
        })
      }),
    )

const embedManyImpl =
  (cfg: Config) =>
  (
    request: OpenAIEmbedManyRequest,
  ): Effect.Effect<EmbedManyResponse, AiError.AiError, HttpClient.HttpClient> =>
    buildBatchBody(request).pipe(
      Effect.flatMap((body) => postEmbed(cfg, body)),
      Effect.map(
        (decoded): EmbedManyResponse => ({
          embeddings: orderedEmbeddings(decoded.data),
          usage: usageOf(decoded.usage),
        }),
      ),
    )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build an `OpenAIEmbeddingService` value. For Layer-based setup, prefer
 * `layer`.
 */
export const make = (
  cfg: Config,
): Effect.Effect<OpenAIEmbeddingService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    embed: (request) =>
      embedImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    embedMany: (request) =>
      embedManyImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer that registers both the provider-specific `OpenAIEmbedding` tag
 * and the generic `EmbeddingModel` tag, sharing one underlying
 * implementation. The generic registration trusts the caller; invalid
 * encodings produce an `InvalidRequest` from OpenAI's API.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<OpenAIEmbedding | EmbeddingModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(OpenAIEmbedding, make(cfg))
  const generic = Layer.effect(
    EmbeddingModel,
    Effect.map(
      make(cfg),
      (s): EmbeddingModelService => ({
        // OpenAI only emits float32; the cast is sound for the 99% case.
        // A caller asking for a non-float32 encoding via the generic tag
        // gets the type they requested but the runtime returns float32.
        embed: <E extends EmbedEncoding | undefined = undefined>(
          req: Omit<CommonEmbedRequest, "encoding"> & { readonly encoding?: E },
        ) => s.embed(req as OpenAIEmbedRequest) as Effect.Effect<EmbedResponse<E>, AiError.AiError>,
        embedMany: <E extends EmbedEncoding | undefined = undefined>(
          req: Omit<CommonEmbedManyRequest, "encoding"> & { readonly encoding?: E },
        ) =>
          s.embedMany(req as OpenAIEmbedManyRequest) as Effect.Effect<
            EmbedManyResponse<E>,
            AiError.AiError
          >,
      }),
    ),
  )
  return Layer.merge(typed, generic)
}
