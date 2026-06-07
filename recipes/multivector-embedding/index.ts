/**
 * Late-interaction (ColBERT-style) retrieval. Embed a query and a set
 * of longer documents with `encoding: "multivector"` on Jina v4 - each
 * input becomes one vector per token instead of one summary vector. Score
 * by `Vector.maxSim`: for each query token, take the max dot product with
 * any document token, sum.
 *
 * Why bother: token-level matching captures fine-grained relevance that
 * single-vector cosine smears out. A query like "store sourdough starter
 * at room temperature" can have each word find its own best-matching
 * point in the document, instead of compressing everything to one point.
 *
 *   pnpm tsx recipes/multivector-embedding/index.ts
 *
 * Requires `JINA_API_KEY` in the environment.
 */
import { Config, Effect, Layer, Logger, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Embedding from "@effect-uai/core/Embedding"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Vector from "@effect-uai/core/Vector"
import { JinaEmbedding, layer as jinaEmbeddingLayer } from "@effect-uai/jina/JinaEmbedding"

// ---------------------------------------------------------------------------
// Corpus - longer docs make the multivector advantage more visible.
// ---------------------------------------------------------------------------

const query = "How do I store my sourdough starter at room temperature?"

const documents = [
  "Sourdough starter is a living culture of wild yeast and lactic-acid bacteria. " +
    "If you bake daily, keep it on the counter at around 22-25°C and feed it once a " +
    "day with equal weights of flour and water. The starter doubles in 4-8 hours " +
    "between feedings depending on the temperature. If you bake less often, refrigerate " +
    "it after a feeding and revive it with two or three feedings before baking.",
  "Marathon training plans typically span 16 to 20 weeks. A weekly schedule includes " +
    "an easy long run that gradually increases in distance, two or three short " +
    "recovery runs, and one tempo or interval session. Cross-training on rest days " +
    "(cycling, swimming) helps avoid overuse injuries. Pay attention to footwear: " +
    "running shoes should be replaced every 500 to 800 kilometers.",
  "TypeScript's structural type system means two interfaces with the same shape are " +
    "interchangeable, even if defined separately. This contrasts with nominal type " +
    "systems (Java, C#) where two classes with identical fields are still distinct " +
    "types. Effect uses structural compatibility heavily for service tags and layer " +
    "composition.",
  "A bread machine automates kneading, proofing, and baking in a single appliance. " +
    "Add ingredients to the bucket, choose a program (basic white, whole wheat, " +
    "French, gluten-free), and the machine takes 3 to 5 hours to deliver a finished " +
    "loaf. The crust tends to be paler than oven-baked bread; some users finish the " +
    "loaf in a hot oven for 5 to 10 minutes for better browning.",
  "Sourdough hydration is the ratio of water to flour by weight. A 75% hydration " +
    "dough has 750 grams of water per 1000 grams of flour. Higher hydration produces " +
    "an open, airy crumb with large irregular holes - characteristic of artisan " +
    "loaves. Lower hydration (60-65%) gives a tighter crumb and is easier to shape, " +
    "common in sandwich-style sourdough.",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const asMultivector = (
  e: Embedding.Embedding,
): Effect.Effect<Embedding.MultivectorEmbedding, AiError.AiError> =>
  Embedding.isMultivector(e)
    ? Effect.succeed(e)
    : Effect.fail(
        new AiError.InvalidRequest({
          provider: "jina",
          param: "encoding",
          raw: `expected multivector embedding, got "${e._tag}"`,
        }),
      )

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const model = "jina-embeddings-v4"

const program = Effect.gen(function* () {
  // `multivector` is Jina-specific: it lives on `JinaEncoding`, not the
  // cross-provider `EmbedEncoding`, so reach for the Jina-typed tag here.
  // The dense baseline below stays on the portable `EmbeddingModel` path.
  const jina = yield* JinaEmbedding.asEffect()
  // One HTTP call each. v4 unifies query + document under `retrieval.*`.
  const [queryResult, docsResult] = yield* Effect.all(
    [
      jina.embed({ model, input: query, task: "retrieval.query", encoding: "multivector" }),
      jina.embedMany({
        model,
        inputs: documents,
        task: "retrieval.passage",
        encoding: "multivector",
      }),
    ],
    { concurrency: "unbounded" },
  )

  const q = yield* asMultivector(queryResult.embedding)
  const docs = yield* Effect.forEach(docsResult.embeddings, asMultivector)

  // For comparison, also score with single-vector cosine. (Re-embed in
  // dense mode so the user can see the multivector ranking pattern
  // against the standard single-vector baseline.)
  const [qDense, docsDense] = yield* Effect.all(
    [
      embed({ model, input: query, task: "query" }),
      embedMany({ model, inputs: documents, task: "document" }),
    ],
    { concurrency: "unbounded" },
  )
  const qVec = Embedding.isFloat32(qDense.embedding) ? qDense.embedding.vector : null
  const docVecs = docsDense.embeddings.map((e) => (Embedding.isFloat32(e) ? e.vector : null))

  const ranked = documents
    .map((doc, i) => {
      const dv = docVecs[i]
      return {
        doc: doc.slice(0, 70) + (doc.length > 70 ? "..." : ""),
        maxSim: Vector.maxSim(q, docs[i]!),
        cosine: qVec !== null && dv !== null && dv !== undefined ? Vector.cosine(qVec, dv) : NaN,
      }
    })
    .sort((a, b) => b.maxSim - a.maxSim)

  yield* Effect.logInfo("query", { query })
  yield* Effect.forEach(ranked, ({ doc, maxSim, cosine }, i) =>
    Effect.logInfo(`#${i + 1}  maxSim=${maxSim.toFixed(3)}  cosine=${cosine.toFixed(4)}`, { doc }),
  )

  // A small tally of vector counts to make multivector concrete.
  const queryTokens = q.vectors.length
  const docTokens = docs.map((d) => d.vectors.length)
  yield* Effect.logInfo("multivector shape", {
    queryTokens,
    docTokens,
    dimsPerVector: q.vectors[0]?.length,
  })
})

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const layer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("JINA_API_KEY")
    return jinaEmbeddingLayer({ apiKey })
  }),
)

const mainLayer = Layer.mergeAll(
  layer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
