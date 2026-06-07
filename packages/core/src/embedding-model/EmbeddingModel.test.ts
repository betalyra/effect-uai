import { Effect } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import type * as AiError from "../domain/AiError.js"
import type {
  BinaryEmbedding,
  Float32Embedding,
  Int8Embedding,
  MultivectorEmbedding,
  SparseEmbedding,
} from "./Embedding.js"
import {
  type EmbedEncoding,
  embed,
  embedMany,
  type EmbedManyResponse,
  type EmbedResponse,
  EmbeddingModel,
} from "./EmbeddingModel.js"

// Type-level tests only. The actual narrowing happens at the type system
// boundary — the runtime impl is exercised in provider-specific test files.
describe("EmbedResponse<E> conditional narrowing", () => {
  it("defaults to Float32Embedding when E is undefined", () => {
    expectTypeOf<EmbedResponse>().toEqualTypeOf<{
      readonly embedding: Float32Embedding
      readonly usage: import("./Embedding.js").Usage
    }>()
  })

  it("maps each encoding literal to the matching Embedding variant", () => {
    expectTypeOf<EmbedResponse<"float32">["embedding"]>().toEqualTypeOf<Float32Embedding>()
    expectTypeOf<EmbedResponse<"int8">["embedding"]>().toEqualTypeOf<Int8Embedding>()
    expectTypeOf<EmbedResponse<"binary">["embedding"]>().toEqualTypeOf<BinaryEmbedding>()
    expectTypeOf<EmbedResponse<"sparse">["embedding"]>().toEqualTypeOf<SparseEmbedding>()
    expectTypeOf<EmbedResponse<"multivector">["embedding"]>().toEqualTypeOf<MultivectorEmbedding>()
  })

  it("falls back to the open Embedding union when E is the full EmbedEncoding", () => {
    expectTypeOf<EmbedResponse<EmbedEncoding>["embedding"]>().toEqualTypeOf<
      Float32Embedding | Int8Embedding | BinaryEmbedding | SparseEmbedding | MultivectorEmbedding
    >()
  })
})

describe("EmbedManyResponse<E> mirrors EmbedResponse<E>", () => {
  it("defaults to ReadonlyArray<Float32Embedding>", () => {
    expectTypeOf<EmbedManyResponse["embeddings"]>().toEqualTypeOf<ReadonlyArray<Float32Embedding>>()
  })

  it("narrows per encoding", () => {
    expectTypeOf<EmbedManyResponse<"int8">["embeddings"]>().toEqualTypeOf<
      ReadonlyArray<Int8Embedding>
    >()
  })
})

describe("embed / embedMany free exports preserve E in their return type", () => {
  it("embed with no encoding returns EmbedResponse<undefined> = Float32", () => {
    const result = embed({ input: "x", model: "m" })
    expectTypeOf(result).toEqualTypeOf<
      Effect.Effect<EmbedResponse<undefined>, AiError.AiError, EmbeddingModel>
    >()
  })

  it("embed with encoding: int8 returns EmbedResponse<int8>", () => {
    const result = embed({ input: "x", model: "m", encoding: "int8" })
    expectTypeOf(result).toEqualTypeOf<
      Effect.Effect<EmbedResponse<"int8">, AiError.AiError, EmbeddingModel>
    >()
  })

  it("embedMany with encoding: binary returns EmbedManyResponse<binary>", () => {
    const result = embedMany({ inputs: ["x"], model: "m", encoding: "binary" })
    expectTypeOf(result).toEqualTypeOf<
      Effect.Effect<EmbedManyResponse<"binary">, AiError.AiError, EmbeddingModel>
    >()
  })

  it("rejects non-dense encodings on the generic path (trimmed EmbedEncoding)", () => {
    // `sparse` / `multivector` are Jina-only representation kinds, not part
    // of the cross-provider request set. Requesting them on the generic
    // helper is a compile error; they're reachable only via the typed
    // `JinaEmbedding` tag.
    // @ts-expect-error "multivector" is not an EmbedEncoding
    embedMany({ inputs: ["x"], model: "m", encoding: "multivector" })
    // @ts-expect-error "sparse" is not an EmbedEncoding
    embed({ input: "x", model: "m", encoding: "sparse" })
  })

  it("when the request is widened to CommonEmbedRequest, the response is the open union", () => {
    // Demonstrates the documented case: annotating the request type erases
    // the literal `encoding` and the response falls back to `Embedding`.
    const req: { input: string; model: string; encoding?: EmbedEncoding } = {
      input: "x",
      model: "m",
      encoding: "int8",
    }
    const result = embed(req)
    expectTypeOf(result).toEqualTypeOf<
      Effect.Effect<EmbedResponse<EmbedEncoding>, AiError.AiError, EmbeddingModel>
    >()
  })
})
