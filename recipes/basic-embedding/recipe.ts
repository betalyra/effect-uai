/**
 * Embed a query and a small set of documents, then rank the documents by
 * cosine similarity to the query. The whole RAG retrieval primitive in one
 * file: no vector DB, no chunker, no reranker.
 *
 * Provider-agnostic: the program yields the generic `EmbeddingModel` tag and
 * takes the model name as a parameter, so swapping providers is a Layer
 * decision made in `app.ts`.
 *
 * Task semantics vary. Jina v4 unifies query and document under `retrieval`,
 * OpenAI has no task field, and `gemini-embedding-2` ignores it. For
 * provider-portable retrieval quality, pick a model that has a task field
 * (`gemini-embedding-001`, Jina v3/v5) and pass `task: "query"` /
 * `task: "document"`.
 */
import { Effect } from "effect"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Vector from "@effect-uai/core/Vector"

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
// Program - provider-agnostic. Picks the model name as a parameter; the
// layer below decides which provider answers.
// ---------------------------------------------------------------------------

export const rankByCosine = (model: string) =>
  Effect.gen(function* () {
    // Query and documents are independent HTTP calls; run them in parallel.
    // No `encoding` field → response is typed as `Float32Embedding`
    // (`EmbedResponse<undefined>`); `.vector` is a `Float32Array` directly,
    // no narrowing helper needed.
    const [queryResult, docsResult] = yield* Effect.all(
      [embed({ model, input: query }), embedMany({ model, inputs: documents })],
      { concurrency: "unbounded" },
    )

    const qVec = queryResult.embedding.vector
    const docVecs = docsResult.embeddings.map((e) => e.vector)

    const ranked = documents
      .map((doc, i) => ({ doc, score: Vector.cosine(qVec, docVecs[i]!) }))
      .sort((a, b) => b.score - a.score)

    yield* Effect.logInfo("query", { query })
    yield* Effect.forEach(ranked, ({ doc, score }, i) =>
      Effect.logInfo(`#${i + 1}  score=${score.toFixed(4)}`, { doc }),
    )
  })
