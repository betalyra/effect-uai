import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { EmbeddingModel, type EmbeddingModelService } from "@effect-uai/core/EmbeddingModel"
import { Reranker } from "@effect-uai/core/Reranker"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import type * as Turn from "@effect-uai/core/Turn"
import { answer, retrieve } from "./recipe.js"

const documents = ["alpha", "bravo", "charlie", "delta", "echo"]

// Cosine against the query [1, 0] descends alpha > bravo > charlie > delta,
// so which documents survive the candidate cut is observable.
const vectors: Record<string, Float32Array> = {
  query: Float32Array.from([1, 0]),
  alpha: Float32Array.from([1, 0.05]),
  bravo: Float32Array.from([1, 0.3]),
  charlie: Float32Array.from([1, 0.7]),
  delta: Float32Array.from([1, 1]),
  echo: Float32Array.from([0, 1]),
}

const float32 = (vector: Float32Array) => ({ _tag: "float32" as const, vector })

// One cast: the service's `embed` is generic in the requested encoding, which
// a fixed float32 stub cannot express.
const embeddings = Layer.succeed(EmbeddingModel, {
  embed: () => Effect.succeed({ embedding: float32(vectors.query!), usage: {} }),
  embedMany: (request: { readonly inputs: ReadonlyArray<string> }) =>
    Effect.succeed({
      embeddings: request.inputs.map((d) => float32(vectors[d]!)),
      usage: {},
    }),
} as unknown as EmbeddingModelService)

/** Scores candidates in reverse, so any reordering has to come from the rerank. */
const reversingReranker = Layer.succeed(Reranker, {
  rerank: (request) =>
    Effect.succeed({
      results: request.documents
        .map((_, index) => ({ index, score: index / 100 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, request.topN ?? request.documents.length),
      usage: {},
    }),
})

const retrieval = (candidates: number, keep: number) =>
  Effect.runPromise(
    retrieve({
      query: "query",
      documents,
      embedModel: "m",
      rerankModel: "r",
      candidates,
      keep,
    }).pipe(Effect.provide(Layer.merge(embeddings, reversingReranker))),
  )

describe("retrieve", () => {
  it("takes the top candidates by cosine, best first", async () => {
    const { cosine } = await retrieval(3, 3)
    expect(cosine.map((c) => documents[c.id])).toEqual(["alpha", "bravo", "charlie"])
    expect(cosine[0]!.score).toBeGreaterThan(cosine[1]!.score)
  })

  it("reorders the candidates by the rerank score", async () => {
    const { reranked } = await retrieval(3, 3)
    expect(reranked.map((r) => documents[r.id])).toEqual(["charlie", "bravo", "alpha"])
  })

  it("reranks only the candidates, never the whole corpus", async () => {
    // "delta" and "echo" lose the cosine cut, so no rerank score can save them.
    const { reranked } = await retrieval(3, 3)
    expect(reranked.map((r) => documents[r.id])).not.toContain("delta")
    expect(reranked.map((r) => documents[r.id])).not.toContain("echo")
  })

  it("maps rerank positions back to corpus ids", async () => {
    // The reranker's index 0 addresses the candidate list it was sent; the
    // returned id must address the corpus.
    const { reranked } = await retrieval(2, 1)
    expect(reranked).toEqual([{ id: 1, score: 0.01 }])
  })

  it("keeps at most `keep` documents for the answer", async () => {
    const { reranked } = await retrieval(4, 2)
    expect(reranked).toHaveLength(2)
  })
})

describe("answer", () => {
  it("grounds the prompt on exactly the context it is given", async () => {
    const turn: Turn.Turn = {
      stop_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      items: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
    }
    const { layer, recorder } = MockProvider.layerWithRecorder([turn])

    const { calls } = await Effect.runPromise(
      Stream.runDrain(answer({ question: "why?", model: "m", context: ["first", "second"] })).pipe(
        Effect.andThen(recorder),
        Effect.provide(layer),
      ),
    )

    const system = JSON.stringify(calls[0]!.history[0])
    expect(system).toContain("1. first")
    expect(system).toContain("2. second")
    expect(system).not.toContain("3.")
  })

  it("stops after one turn: no tools, nothing to feed back", async () => {
    const turn: Turn.Turn = {
      stop_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      items: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
    }
    const { layer, recorder } = MockProvider.layerWithRecorder([turn, turn])

    const { calls } = await Effect.runPromise(
      Stream.runDrain(answer({ question: "why?", model: "m", context: ["first"] })).pipe(
        Effect.andThen(recorder),
        Effect.provide(layer),
      ),
    )

    expect(calls).toHaveLength(1)
  })
})
