import type { ImageSource } from "../domain/Image.js"

/**
 * One part of a mixed text+image input. Used inside `EmbedInput.content[]`
 * for providers that accept interleaved modalities in a single embed call
 * (Cohere v4, Voyage multimodal, Jina v4, Google `gemini-embedding-2`).
 */
export type EmbedContentPart = { readonly text: string } | { readonly image: ImageSource }

/**
 * What you embed. The `string` shorthand covers the common text-only case;
 * structured variants exist for image-only and mixed-modality inputs.
 *
 * Not every provider accepts every variant: text-only providers (OpenAI,
 * Mixedbread today) handle `string` and `{ text }`; multimodal providers
 * (Google, Jina v4, Voyage multimodal, Cohere v4) handle all four. A
 * provider layer rejects shapes it can't encode as `AiError.InvalidRequest`.
 */
export type EmbedInput =
  | string
  | { readonly text: string }
  | { readonly image: ImageSource }
  | { readonly content: ReadonlyArray<EmbedContentPart> }

// ---------------------------------------------------------------------------
// Embedding representations
//
// The `_tag` reflects the wire form the provider returned, *not* what the
// consumer asked for - request `encoding: "int8"` and you get back an
// `Int8Embedding`. Math primitives are typed against the named interfaces
// (see `Vector.ts`) so e.g. `sparseCosine` only accepts `SparseEmbedding`.
// ---------------------------------------------------------------------------

/** Dense float32 vector. The default representation across all providers. */
export type Float32Embedding = {
  readonly _tag: "float32"
  readonly vector: Float32Array
}

/**
 * Dense int8-quantized vector. ~4x smaller than float32 with minimal
 * recall loss on most benchmarks.
 */
export type Int8Embedding = {
  readonly _tag: "int8"
  readonly vector: Int8Array
}

/**
 * Dense binary-quantized vector. One bit per dimension, packed into bytes.
 * ~32x smaller than float32; meaningful recall loss but useful for hot
 * indexes paired with a float32 reranker pass.
 */
export type BinaryEmbedding = {
  readonly _tag: "binary"
  readonly vector: Uint8Array
}

/**
 * Sparse vector. Token-keyed weights for hybrid search (dense + lexical-
 * style sparse). The single hosted producer today is Jina's `elser-v2`
 * model, which returns subword tokens (e.g. `"bread"`, `"##ing"`) with
 * their relevance weights.
 *
 * The shape is `Record<string, number>` rather than `(indices, values)`
 * because real hosted learned-sparse encoders (ELSER, SPLADE) emit token
 * strings with no shared vocabulary index. Converting to integer indices
 * would either need a vocabulary table the model doesn't expose, or
 * lose the cross-vector matching semantics. If a provider ever exposes
 * index-valued sparse vectors (Pinecone-style, where you bring your own
 * vocab), add an `IndexSparseEmbedding` sibling arm with `_tag:
 * "sparse-indexed"`.
 *
 * Score with `Vector.sparseCosine` — dot product over the intersection
 * of keys, normalized by the L2 norms of both maps.
 */
export type SparseEmbedding = {
  readonly _tag: "sparse"
  readonly weights: Readonly<Record<string, number>>
}

/**
 * Multivector / late-interaction output: one float32 vector per token.
 * Score documents with `Vector.maxSim` (ColBERT-style: per query vector,
 * max dot product across doc vectors, summed). Typically ~50-500 vectors
 * per document, each shorter than a single-vector embedding (~128 dim
 * vs ~1024).
 *
 * Quantized multivector forms aren't modeled for the same reason as
 * sparse - nothing on hosted APIs ships them yet.
 */
export type MultivectorEmbedding = {
  readonly _tag: "multivector"
  readonly vectors: ReadonlyArray<Float32Array>
}

export type Embedding =
  | Float32Embedding
  | Int8Embedding
  | BinaryEmbedding
  | SparseEmbedding
  | MultivectorEmbedding

export const isFloat32 = (e: Embedding): e is Float32Embedding => e._tag === "float32"
export const isInt8 = (e: Embedding): e is Int8Embedding => e._tag === "int8"
export const isBinary = (e: Embedding): e is BinaryEmbedding => e._tag === "binary"
export const isSparse = (e: Embedding): e is SparseEmbedding => e._tag === "sparse"
export const isMultivector = (e: Embedding): e is MultivectorEmbedding => e._tag === "multivector"

/**
 * Maps an `encoding` request field to the corresponding response embedding
 * variant. `undefined` (no encoding requested) defaults to `Float32Embedding`,
 * which is what every provider returns when the caller doesn't ask for
 * anything else. Widened `E` falls back to the full `Embedding` union — the
 * caller has to narrow at use site, which honestly reflects what they know
 * at compile time.
 *
 * Used by `EmbedResponse<E>` / `EmbedManyResponse<E>` to give callers a
 * precise embedding type without a runtime narrowing helper.
 */
export type EmbeddingFor<E> = [E] extends [undefined | "float32"]
  ? Float32Embedding
  : [E] extends ["int8"]
    ? Int8Embedding
    : [E] extends ["binary"]
      ? BinaryEmbedding
      : [E] extends ["sparse"]
        ? SparseEmbedding
        : [E] extends ["multivector"]
          ? MultivectorEmbedding
          : Embedding

/**
 * Token usage for one embed / embedMany call. One value per HTTP request,
 * not per input vector. Most providers populate `inputTokens`; the field
 * is optional for those that don't (or for mock layers in tests).
 */
export type Usage = {
  readonly inputTokens?: number
}
