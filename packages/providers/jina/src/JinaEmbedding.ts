import { Context, Effect, Encoding, Layer, Match, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { Embedding, EmbedContentPart, EmbedInput, Usage } from "@effect-uai/core/Embedding"

// Internal open-union response shape — impls return this; the typed
// `make()` wrapper casts to the narrowed `EmbedResponse<E>`.
type AnyEmbedResponse = { readonly embedding: Embedding; readonly usage: Usage }
type AnyEmbedManyResponse = { readonly embeddings: ReadonlyArray<Embedding>; readonly usage: Usage }
import {
  type CommonEmbedManyRequest,
  type CommonEmbedRequest,
  type EmbedEncoding,
  EmbeddingModel,
  type EmbeddingModelService,
  type EmbedManyResponse,
  type EmbedResponse,
} from "@effect-uai/core/EmbeddingModel"
import type { ImageSource } from "@effect-uai/core/Image"
import type { JinaEmbeddingModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Jina's task vocabulary. v4 and v3/v5 share the dotted-pair form:
 * - `retrieval.query` / `retrieval.passage` — asymmetric retrieval.
 * - `text-matching` — symmetric similarity between two texts.
 * - `code.query` / `code.passage` — code retrieval / matching (v4-only).
 * - `classification` / `separation` — v3 / v5 only.
 *
 * The `(string & {})` tail accepts any string so newly-released task
 * types work without an SDK update.
 */
export type JinaTask =
  | "retrieval.query"
  | "retrieval.passage"
  | "text-matching"
  | "code.query"
  | "code.passage"
  | "classification"
  | "separation"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Jina's supported `encoding` values. Provider-narrowed from the cross-
 * provider `EmbedEncoding` union.
 *
 * Compatibility with models is checked at the response level rather than
 * pre-flight: if you ask for `multivector` against a model that doesn't
 * produce one, Jina's API rejects the request with a clear error; if
 * you ask for `sparse` and the chosen model returns dense, our decoder
 * fails with a typed mismatch. No hardcoded model-encoding table to
 * maintain.
 *
 * Wire mapping:
 * - `multivector` → request sets `return_multivector: true`
 *   (`jina-embeddings-v4` + ColBERT models).
 * - `sparse` → no flag; the model itself (`elser-v2`) determines the
 *   output shape.
 * - `binary` → request sets `embedding_type: "binary"`.
 * - `float32` → no flag; default JSON `number[]`.
 */
export type JinaEncoding = "float32" | "binary" | "sparse" | "multivector"

export type JinaEmbedRequest = Omit<CommonEmbedRequest, "model" | "task" | "encoding"> & {
  /** Narrows `CommonEmbedRequest.model` to the typed Jina union. */
  readonly model: JinaEmbeddingModel
  /**
   * Widens the cross-provider `"query" | "document"` to Jina's task enum.
   * Required by v3+ for retrieval-quality results. v4 unifies query and
   * document under `retrieval`.
   */
  readonly task?: JinaTask
  /** Narrows `CommonEmbedRequest.encoding` to Jina's supported set. */
  readonly encoding?: JinaEncoding
}

export type JinaEmbedManyRequest = Omit<JinaEmbedRequest, "input"> & {
  readonly inputs: ReadonlyArray<EmbedInput>
}

export type JinaEmbeddingService = {
  readonly embed: <E extends JinaEncoding | undefined = undefined>(
    request: Omit<JinaEmbedRequest, "encoding"> & { readonly encoding?: E },
  ) => Effect.Effect<EmbedResponse<E>, AiError.AiError>
  readonly embedMany: <E extends JinaEncoding | undefined = undefined>(
    request: Omit<JinaEmbedManyRequest, "encoding"> & { readonly encoding?: E },
  ) => Effect.Effect<EmbedManyResponse<E>, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Jina-typed embedding
 * requests; yield the generic `EmbeddingModel` tag for provider-portable
 * code. Both are registered by `layer`.
 */
export class JinaEmbedding extends Context.Service<JinaEmbedding, JinaEmbeddingService>()(
  "@betalyra/effect-uai/providers/jina/JinaEmbedding",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

type WireTextItem = {
  readonly text: string
}
type WireImageItem = {
  readonly image: string
}
type WireItem = WireTextItem | WireImageItem

/**
 * Jina v4 accepts `{ image: <url> }` or `{ image: <base64-string> }`.
 * The server detects which form by looking at the value. We pass URLs
 * through directly and base64-encode raw bytes.
 */
const imageSourceToItem: (s: ImageSource) => WireItem = Match.type<ImageSource>().pipe(
  Match.tag("url", (s): WireItem => ({ image: s.url })),
  Match.tag("base64", (s): WireItem => ({ image: s.base64 })),
  Match.tag("bytes", (s): WireItem => ({ image: Encoding.encodeBase64(s.bytes) })),
  Match.exhaustive,
)

const contentPartToItem: (part: EmbedContentPart) => WireItem = Match.type<EmbedContentPart>().pipe(
  Match.when({ text: Match.string }, ({ text }): WireItem => ({ text })),
  Match.when({ image: Match.any }, ({ image }) => imageSourceToItem(image)),
  Match.exhaustive,
)

const multiPartContentRejected: AiError.AiError = new AiError.InvalidRequest({
  provider: "jina",
  param: "input.content",
  raw: "Jina treats each input[] entry as one item; multi-part `content[]` would lose the grouping. Split into separate `inputs[]` entries.",
})

/**
 * Project an `EmbedInput` to one wire item. A single-part `content[]` is
 * unwrapped; multi-part `content[]` is rejected because Jina's flat
 * `input[]` would lose the grouping.
 */
const inputToItem: (input: EmbedInput) => Effect.Effect<WireItem, AiError.AiError> =
  Match.type<EmbedInput>().pipe(
    Match.when(
      Match.string,
      (s): Effect.Effect<WireItem, AiError.AiError> => Effect.succeed({ text: s }),
    ),
    Match.when(
      { text: Match.string },
      ({ text }): Effect.Effect<WireItem, AiError.AiError> => Effect.succeed({ text }),
    ),
    Match.when(
      { image: Match.any },
      ({ image }): Effect.Effect<WireItem, AiError.AiError> =>
        Effect.succeed(imageSourceToItem(image)),
    ),
    Match.when(
      { content: Match.any },
      ({ content }): Effect.Effect<WireItem, AiError.AiError> =>
        content.length === 1
          ? Effect.succeed(contentPartToItem(content[0]!))
          : Effect.fail(multiPartContentRejected),
    ),
    Match.exhaustive,
  )

type WireBody = {
  readonly model: string
  readonly input: ReadonlyArray<WireItem>
  readonly task?: string
  readonly dimensions?: number
  readonly embedding_type?: "float" | "base64" | "binary" | "ubinary"
  readonly return_multivector?: boolean
}

type WireQuant = WireBody["embedding_type"]

/**
 * Map our `JinaEncoding` to Jina's `embedding_type` wire field. Only
 * `binary` actually changes the wire transport; the others either omit
 * the field (`float32`) or ignore it (`sparse` / `multivector` use
 * separate signalling — model choice and `return_multivector`).
 */
const encodingToQuant: (encoding: JinaEncoding | undefined) => WireQuant = Match.type<
  JinaEncoding | undefined
>().pipe(
  Match.when("binary", (): WireQuant => "binary"),
  Match.orElse((): WireQuant => undefined),
)

const buildBody = (request: {
  readonly model: JinaEmbeddingModel
  readonly task?: JinaTask
  readonly dimensions?: number
  readonly encoding?: JinaEncoding
  readonly items: ReadonlyArray<WireItem>
}): WireBody => {
  const quant = encodingToQuant(request.encoding)
  return {
    model: request.model,
    input: request.items,
    ...(request.task !== undefined && { task: request.task }),
    ...(request.dimensions !== undefined && { dimensions: request.dimensions }),
    ...(quant !== undefined && { embedding_type: quant }),
    ...(request.encoding === "multivector" && { return_multivector: true }),
  }
}

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

/**
 * Wire response payloads. Split into four discriminated schemas so the
 * decoder can narrow precisely via `Schema.is`:
 *
 * - **Dense float** (`object: "embedding"`, `embedding: number[]`) —
 *   default JSON form.
 * - **Dense base64** (`object: "embedding"`, `embedding: string`) — set
 *   when `embedding_type` was `base64` or `binary`.
 * - **Sparse** (`object: "embedding"`, `embedding: Record<string,
 *   number>`) — token-keyed weights from an ELSER-style model.
 * - **Multivector** (`object: "embeddings"`, plural) — token-level
 *   vectors when `return_multivector: true` or a ColBERT model is used.
 */
const WireDenseFloatPayload = Schema.Struct({
  object: Schema.Literal("embedding"),
  index: Schema.Number,
  embedding: Schema.Array(Schema.Number),
})
type WireDenseFloatPayload = typeof WireDenseFloatPayload.Type

const WireDenseBase64Payload = Schema.Struct({
  object: Schema.Literal("embedding"),
  index: Schema.Number,
  embedding: Schema.String,
})
type WireDenseBase64Payload = typeof WireDenseBase64Payload.Type

const WireSparsePayload = Schema.Struct({
  object: Schema.Literal("embedding"),
  index: Schema.Number,
  embedding: Schema.Record(Schema.String, Schema.Number),
})
type WireSparsePayload = typeof WireSparsePayload.Type

const WireMultiPayload = Schema.Struct({
  object: Schema.Literal("embeddings"),
  index: Schema.Number,
  embeddings: Schema.Array(Schema.Array(Schema.Number)),
  tokenized_input: Schema.optional(Schema.Array(Schema.String)),
})
type WireMultiPayload = typeof WireMultiPayload.Type

// Order matters: more specific schemas first. Dense float (array) and
// multivector (different `object`) are unambiguous; sparse vs base64
// disambiguate by the `embedding` field type.
const WirePayload = Schema.Union([
  WireDenseFloatPayload,
  WireSparsePayload,
  WireDenseBase64Payload,
  WireMultiPayload,
])
type WirePayload = typeof WirePayload.Type

const isMultiPayload = Schema.is(WireMultiPayload)
const isSparsePayload = Schema.is(WireSparsePayload)
const isDenseBase64Payload = Schema.is(WireDenseBase64Payload)

const WireUsage = Schema.Struct({
  total_tokens: Schema.Number,
  prompt_tokens: Schema.optional(Schema.Number),
})
type WireUsage = typeof WireUsage.Type

const WireResponse = Schema.Struct({
  data: Schema.Array(WirePayload),
  model: Schema.String,
  usage: WireUsage,
})

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "jina", raw: cause })

const encodingMismatch = (expected: JinaEncoding, got: string): AiError.AiError =>
  new AiError.InvalidRequest({
    provider: "jina",
    param: "encoding",
    raw: `requested encoding="${expected}" but the response contains a ${got} embedding - confirm the chosen model supports the requested encoding`,
  })

/** Decode a base64 wire string to the right dense `Embedding` arm. */
const decodeBase64Embedding = (
  b64: string,
  encoding: JinaEncoding | undefined,
): Effect.Effect<Embedding, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onFailure: (cause) => Effect.fail(transportFailure(cause)),
    onSuccess: (bytes) =>
      Match.value(encoding).pipe(
        Match.when(
          "binary",
          (): Effect.Effect<Embedding, AiError.AiError> =>
            Effect.succeed({ _tag: "binary", vector: bytes }),
        ),
        Match.orElse(
          (): Effect.Effect<Embedding, AiError.AiError> =>
            Effect.succeed({
              _tag: "float32",
              vector: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
            }),
        ),
      ),
  })

/**
 * Project a wire payload to our `Embedding` discriminated union and
 * verify the requested encoding matches what came back.
 */
const payloadToEmbedding = (
  payload: WirePayload,
  encoding: JinaEncoding | undefined,
): Effect.Effect<Embedding, AiError.AiError> => {
  if (isMultiPayload(payload)) {
    return encoding === "multivector"
      ? Effect.succeed<Embedding>({
          _tag: "multivector",
          vectors: payload.embeddings.map((v) => Float32Array.from(v)),
        })
      : Effect.fail(encodingMismatch(encoding ?? "float32", "multivector"))
  }
  if (isSparsePayload(payload)) {
    return encoding === "sparse"
      ? Effect.succeed<Embedding>({ _tag: "sparse", weights: payload.embedding })
      : Effect.fail(encodingMismatch(encoding ?? "float32", "sparse"))
  }
  // Dense (float array or base64 string).
  if (encoding === "multivector" || encoding === "sparse") {
    return Effect.fail(encodingMismatch(encoding, "dense"))
  }
  return isDenseBase64Payload(payload)
    ? decodeBase64Embedding(payload.embedding, encoding)
    : Effect.succeed<Embedding>({
        _tag: "float32",
        vector: Float32Array.from(payload.embedding),
      })
}

const indexOf = (p: WirePayload): number => p.index

const usageOf = (u: WireUsage): Usage => ({ inputTokens: u.total_tokens })

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.jina.ai/v1"

const postEmbed = (
  cfg: Config,
  body: WireBody,
): Effect.Effect<typeof WireResponse.Type, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/embeddings`).pipe(
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

const orderedEmbeddings = (
  data: ReadonlyArray<WirePayload>,
  encoding: JinaEncoding | undefined,
): Effect.Effect<ReadonlyArray<Embedding>, AiError.AiError> =>
  Effect.forEach(
    [...data].sort((a, b) => indexOf(a) - indexOf(b)),
    (item) => payloadToEmbedding(item, encoding),
  )

const embedImpl =
  (cfg: Config) =>
  (
    request: JinaEmbedRequest,
  ): Effect.Effect<AnyEmbedResponse, AiError.AiError, HttpClient.HttpClient> =>
    inputToItem(request.input).pipe(
      Effect.flatMap((item) =>
        postEmbed(
          cfg,
          buildBody({
            model: request.model,
            ...(request.task !== undefined && { task: request.task }),
            ...(request.dimensions !== undefined && { dimensions: request.dimensions }),
            ...(request.encoding !== undefined && { encoding: request.encoding }),
            items: [item],
          }),
        ),
      ),
      Effect.flatMap((decoded) => {
        const first = decoded.data[0]
        if (first === undefined) {
          return Effect.fail(transportFailure("Jina returned empty `data` array"))
        }
        return payloadToEmbedding(first, request.encoding).pipe(
          Effect.map(
            (embedding): AnyEmbedResponse => ({ embedding, usage: usageOf(decoded.usage) }),
          ),
        )
      }),
    )

const embedManyImpl =
  (cfg: Config) =>
  (
    request: JinaEmbedManyRequest,
  ): Effect.Effect<AnyEmbedManyResponse, AiError.AiError, HttpClient.HttpClient> =>
    Effect.forEach(request.inputs, inputToItem).pipe(
      Effect.flatMap((items) =>
        postEmbed(
          cfg,
          buildBody({
            model: request.model,
            ...(request.task !== undefined && { task: request.task }),
            ...(request.dimensions !== undefined && { dimensions: request.dimensions }),
            ...(request.encoding !== undefined && { encoding: request.encoding }),
            items,
          }),
        ),
      ),
      Effect.flatMap((decoded) =>
        orderedEmbeddings(decoded.data, request.encoding).pipe(
          Effect.map(
            (embeddings): AnyEmbedManyResponse => ({
              embeddings,
              usage: usageOf(decoded.usage),
            }),
          ),
        ),
      ),
    )

/**
 * Map cross-provider `query`/`document` to Jina's dotted-pair task
 * vocabulary. `undefined` stays `undefined`.
 */
const mapGenericTask: (t: "query" | "document" | undefined) => JinaTask | undefined = Match.type<
  "query" | "document" | undefined
>().pipe(
  Match.when("query", (): JinaTask => "retrieval.query"),
  Match.when("document", (): JinaTask => "retrieval.passage"),
  Match.orElse((): JinaTask | undefined => undefined),
)

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `JinaEmbeddingService` value. For Layer-based setup, prefer
 * `layer`.
 */
export const make = (
  cfg: Config,
): Effect.Effect<JinaEmbeddingService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    embed: <E extends JinaEncoding | undefined = undefined>(
      request: Omit<JinaEmbedRequest, "encoding"> & { readonly encoding?: E },
    ) =>
      embedImpl(cfg)(request as JinaEmbedRequest).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ) as Effect.Effect<EmbedResponse<E>, AiError.AiError>,
    embedMany: <E extends JinaEncoding | undefined = undefined>(
      request: Omit<JinaEmbedManyRequest, "encoding"> & { readonly encoding?: E },
    ) =>
      embedManyImpl(cfg)(request as JinaEmbedManyRequest).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ) as Effect.Effect<EmbedManyResponse<E>, AiError.AiError>,
  }))

/**
 * Layer that registers both the provider-specific `JinaEmbedding` tag
 * and the generic `EmbeddingModel` tag, sharing one underlying
 * implementation. The generic registration maps cross-provider
 * `query`/`document` to Jina's `retrieval.query` / `retrieval.passage`
 * task strings; other request fields pass through.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<JinaEmbedding | EmbeddingModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(JinaEmbedding, make(cfg))
  const generic = Layer.effect(
    EmbeddingModel,
    Effect.map(
      make(cfg),
      (s): EmbeddingModelService => ({
        embed: <E extends EmbedEncoding | undefined = undefined>(
          req: Omit<CommonEmbedRequest, "encoding"> & { readonly encoding?: E },
        ) => {
          const task = mapGenericTask(req.task)
          return s.embed({
            ...req,
            model: req.model as JinaEmbeddingModel,
            ...(task !== undefined && { task }),
          } as JinaEmbedRequest) as Effect.Effect<EmbedResponse<E>, AiError.AiError>
        },
        embedMany: <E extends EmbedEncoding | undefined = undefined>(
          req: Omit<CommonEmbedManyRequest, "encoding"> & { readonly encoding?: E },
        ) => {
          const task = mapGenericTask(req.task)
          return s.embedMany({
            ...req,
            model: req.model as JinaEmbeddingModel,
            ...(task !== undefined && { task }),
          } as JinaEmbedManyRequest) as Effect.Effect<EmbedManyResponse<E>, AiError.AiError>
        },
      }),
    ),
  )
  return Layer.merge(typed, generic)
}
