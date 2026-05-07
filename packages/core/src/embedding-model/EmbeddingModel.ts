import { Context, Effect } from "effect"
import * as AiError from "../domain/AiError.js"
import type { Embedding, EmbedInput, Usage } from "./Embedding.js"

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
export interface CommonEmbedRequest {
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
   * Vector quantization. `float32` is the default; `int8` and `binary`
   * trade precision for storage. Not every provider supports every
   * variant - Google ignores this entirely; OpenAI only honours
   * `float32` and a base64-encoded float32 transport.
   */
  readonly encoding?: "float32" | "int8" | "binary"
}

/**
 * Cross-provider batch-embed request. One `task` for the whole batch -
 * mixed-task batches aren't a real provider feature (rerankers exist for
 * that).
 */
export interface CommonEmbedManyRequest extends Omit<CommonEmbedRequest, "input"> {
  readonly inputs: ReadonlyArray<EmbedInput>
}

export interface EmbedResponse {
  readonly embedding: Embedding
  readonly usage: Usage
}

export interface EmbedManyResponse {
  readonly embeddings: ReadonlyArray<Embedding>
  readonly usage: Usage
}

export interface EmbeddingModelService {
  readonly embed: (request: CommonEmbedRequest) => Effect.Effect<EmbedResponse, AiError.AiError>
  readonly embedMany: (
    request: CommonEmbedManyRequest,
  ) => Effect.Effect<EmbedManyResponse, AiError.AiError>
}

export class EmbeddingModel extends Context.Service<EmbeddingModel, EmbeddingModelService>()(
  "@betalyra/effect-uai/EmbeddingModel",
) {}

/** Embed a single input. */
export const embed = (
  request: CommonEmbedRequest,
): Effect.Effect<EmbedResponse, AiError.AiError, EmbeddingModel> =>
  Effect.flatMap(EmbeddingModel.asEffect(), (m) => m.embed(request))

/** Embed a batch in one provider call. Same `task` for every input. */
export const embedMany = (
  request: CommonEmbedManyRequest,
): Effect.Effect<EmbedManyResponse, AiError.AiError, EmbeddingModel> =>
  Effect.flatMap(EmbeddingModel.asEffect(), (m) => m.embedMany(request))
