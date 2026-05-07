/**
 * Embed a query and a small set of documents, then rank the documents by
 * cosine similarity to the query. The whole RAG retrieval primitive in
 * one file - no vector DB, no chunker, no reranker.
 *
 *   pnpm tsx recipes/basic-embedding/index.ts
 *
 * Requires `GOOGLE_API_KEY` in the environment.
 *
 * Uses `gemini-embedding-2` - Google's GA multimodal embedding model.
 * Note: `gemini-embedding-2` ignores `taskType`; instead, prepend task
 * instructions to the text yourself (we omit `task` here for simplicity).
 * For the older `gemini-embedding-001` you would pass `task: "query"` /
 * `task: "document"` and the layer would forward it as `taskType`.
 */
import { Config, Effect, Layer, Logger, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Embedding from "@effect-uai/core/Embedding"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import { layer as geminiEmbeddingLayer } from "@effect-uai/google/GeminiEmbedding"

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const query = "How do I make sourdough bread at home?"

const documents = [
  "A classic guide to baking artisan sourdough loaves with a wild yeast starter.",
  "Tips for choosing the right running shoes for marathon training.",
  "Bread machines automate kneading, proofing, and baking for everyday loaves.",
  "Effect is a TypeScript library for typed errors and resource management.",
  "Hydration ratios above 75% give sourdough an open, airy crumb.",
]

// ---------------------------------------------------------------------------
// Cosine similarity. At recipe-volume this is fine; vector DBs do this
// server-side for millions of vectors.
// ---------------------------------------------------------------------------

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const asFloat32 = (e: Embedding.Embedding): Effect.Effect<Float32Array, AiError.AiError> =>
  Embedding.isFloat32(e)
    ? Effect.succeed(e.vector)
    : Effect.fail(
        new AiError.InvalidRequest({
          provider: "gemini",
          param: "encoding",
          raw: `expected float32 embedding, got "${e._tag}"`,
        }),
      )

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const model = "gemini-embedding-2"

const program = Effect.gen(function* () {
  // Query and documents are independent HTTP calls; run them in parallel.
  const [queryResult, docsResult] = yield* Effect.all(
    [
      embed({ model, input: query }),
      embedMany({ model, inputs: documents }),
    ],
    { concurrency: "unbounded" },
  )

  const qVec = yield* asFloat32(queryResult.embedding)
  const docVecs = yield* Effect.forEach(docsResult.embeddings, asFloat32)

  const ranked = documents
    .map((doc, i) => ({ doc, score: cosine(qVec, docVecs[i]!) }))
    .sort((a, b) => b.score - a.score)

  yield* Effect.logInfo("query", { query })
  yield* Effect.forEach(ranked, ({ doc, score }, i) =>
    Effect.logInfo(`#${i + 1}  score=${score.toFixed(4)}`, { doc }),
  )
})

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const layer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return geminiEmbeddingLayer({ apiKey })
  }),
)

const runtime = Layer.mergeAll(
  layer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(
    Effect.provide(runtime),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
