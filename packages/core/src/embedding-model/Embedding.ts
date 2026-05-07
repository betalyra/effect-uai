import type { ImageSource } from "../domain/Image.js"

/**
 * One part of a mixed text+image input. Used inside `EmbedInput.content[]`
 * for providers that accept interleaved modalities in a single embed call
 * (Cohere v4, Voyage multimodal, Jina v4, Google `gemini-embedding-2`).
 */
export type EmbedContentPart =
  | { readonly text: string }
  | { readonly image: ImageSource }

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

/**
 * One embedding vector. The `_tag` reflects the wire encoding the provider
 * returned, *not* what the consumer wants - request `encoding: "int8"` and
 * you get back `{ _tag: "int8", vector: Int8Array }`.
 *
 * Sparse / multivector outputs (Jina v4 only on hosted APIs) are not
 * modeled here. They can be added later as additional `_tag` arms without
 * breaking existing consumers.
 */
export type Embedding =
  | { readonly _tag: "float32"; readonly vector: Float32Array }
  | { readonly _tag: "int8"; readonly vector: Int8Array }
  | { readonly _tag: "binary"; readonly vector: Uint8Array }

export const isFloat32 = (e: Embedding): e is Extract<Embedding, { _tag: "float32" }> =>
  e._tag === "float32"

export const isInt8 = (e: Embedding): e is Extract<Embedding, { _tag: "int8" }> =>
  e._tag === "int8"

export const isBinary = (e: Embedding): e is Extract<Embedding, { _tag: "binary" }> =>
  e._tag === "binary"

/**
 * Token usage for one embed / embedMany call. One value per HTTP request,
 * not per input vector. Most providers populate `inputTokens`; the field
 * is optional for those that don't (or for mock layers in tests).
 */
export interface Usage {
  readonly inputTokens?: number
}
