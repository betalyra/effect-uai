import { Context, Effect } from "effect"
import * as AiError from "../domain/AiError.js"
import type { EmbeddingFor, EmbedInput, Usage } from "./Embedding.js"

/**
 * Output representation requested from the provider.
 *
 * Dense quantizations - same vector at different storage cost:
 * - `float32` — universal default.
 * - `int8` — ~4x smaller; minimal recall loss on most benchmarks.
 * - `binary` — ~32x smaller; meaningful recall loss but pairs well with
 *   a float32 reranker pass over a small candidate set.
 *
 * Non-dense representations:
 * - `sparse` — learned sparse vector for hybrid (dense + lexical) search.
 *   Currently Jina ELSER only on hosted APIs.
 * - `multivector` — one vector per token for late-interaction (ColBERT-
 *   style) scoring via `Vector.maxSim`. Currently Jina v4 only.
 *
 * Each provider's typed request narrows this to its supported set at
 * compile time (e.g. `JinaEmbedEncoding = "float32" | "binary" | "sparse" |
 * "multivector"`). On the generic `EmbeddingModel` path, callers can
 * pass any `EmbedEncoding` and the provider's API will reject mismatches at
 * runtime.
 */
export type EmbedEncoding = "float32" | "int8" | "binary" | "sparse" | "multivector"

/**
 * Cross-provider single-embed request. Mirrors the shape of
 * `LanguageModel.CommonRequest`: cross-cutting fields here, vendor
 * specifics in the provider's typed request.
 *
 * Provider-specific extensions (Cohere widened `task` enum, Jina LoRA
 * tasks, Mixedbread free-form `prompt`, etc.) live in that provider's own
 * request interface, which extends this and narrows `model` / widens
 * `task`.
 */
export type CommonEmbedRequest = {
  readonly input: EmbedInput
  /**
   * Model identifier. Each provider narrows this to its typed literal
   * union, so code that yields a typed provider tag gets autocompletion.
   */
  readonly model: string
  /**
   * Retrieval-task hint. Applies to the input. OpenAI ignores this;
   * Mixedbread doesn't have it; Cohere v3+ requires it on the wire (typed
   * as required in `CohereEmbedRequest`). Provider-specific task enums
   * (classification, clustering, code retrieval, …) live on the
   * provider's own request type.
   */
  readonly task?: "query" | "document"
  /**
   * Matryoshka truncation. Default: provider's native dimension.
   * Discrete-value providers (Cohere, Vertex `multimodalembedding@001`)
   * narrow this to a literal union in their typed request.
   */
  readonly dimensions?: number
  /**
   * Output representation - see {@link EmbedEncoding}. Dense float32 is the
   * default; provider layers reject unsupported values up front with
   * `InvalidRequest`.
   */
  readonly encoding?: EmbedEncoding
}

/**
 * Cross-provider batch-embed request. One `task` for the whole batch -
 * mixed-task batches aren't a real provider feature (rerankers exist for
 * that).
 */
export type CommonEmbedManyRequest = Omit<CommonEmbedRequest, "input"> & {
  readonly inputs: ReadonlyArray<EmbedInput>
}

/**
 * Single-embed response. The `embedding` type is determined by the
 * request's `encoding` field via `EmbeddingFor<E>` — callers that don't
 * specify an encoding get a `Float32Embedding` directly with no runtime
 * narrowing. Defaults to `undefined` for back-compat with consumers that
 * use the bare `EmbedResponse` name.
 */
export type EmbedResponse<E extends EmbedEncoding | undefined = undefined> = {
  readonly embedding: EmbeddingFor<E>
  readonly usage: Usage
}

/** Batch-embed response. Same encoding rule as {@link EmbedResponse}. */
export type EmbedManyResponse<E extends EmbedEncoding | undefined = undefined> = {
  readonly embeddings: ReadonlyArray<EmbeddingFor<E>>
  readonly usage: Usage
}

export type EmbeddingModelService = {
  readonly embed: <E extends EmbedEncoding | undefined = undefined>(
    request: Omit<CommonEmbedRequest, "encoding"> & { readonly encoding?: E },
  ) => Effect.Effect<EmbedResponse<E>, AiError.AiError>
  readonly embedMany: <E extends EmbedEncoding | undefined = undefined>(
    request: Omit<CommonEmbedManyRequest, "encoding"> & { readonly encoding?: E },
  ) => Effect.Effect<EmbedManyResponse<E>, AiError.AiError>
}

export class EmbeddingModel extends Context.Service<EmbeddingModel, EmbeddingModelService>()(
  "@betalyra/effect-uai/EmbeddingModel",
) {}

/** Embed a single input. */
export const embed = <E extends EmbedEncoding | undefined = undefined>(
  request: Omit<CommonEmbedRequest, "encoding"> & { readonly encoding?: E },
): Effect.Effect<EmbedResponse<E>, AiError.AiError, EmbeddingModel> =>
  Effect.flatMap(EmbeddingModel.asEffect(), (m) => m.embed(request))

/** Embed a batch in one provider call. Same `task` for every input. */
export const embedMany = <E extends EmbedEncoding | undefined = undefined>(
  request: Omit<CommonEmbedManyRequest, "encoding"> & { readonly encoding?: E },
): Effect.Effect<EmbedManyResponse<E>, AiError.AiError, EmbeddingModel> =>
  Effect.flatMap(EmbeddingModel.asEffect(), (m) => m.embedMany(request))
