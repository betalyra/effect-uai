/**
 * Embed a query and a small set of documents, then rank the documents by
 * cosine similarity to the query. The whole RAG retrieval primitive in
 * one file - no vector DB, no chunker, no reranker.
 *
 * Switch providers via `--provider`:
 *
 *   pnpm tsx recipes/basic-embedding/index.ts --provider=gemini
 *   pnpm tsx recipes/basic-embedding/index.ts --provider=openai
 *   pnpm tsx recipes/basic-embedding/index.ts --provider=jina
 *
 * Requires the matching API key in the environment
 * (`GOOGLE_API_KEY` / `OPENAI_API_KEY` / `JINA_API_KEY`).
 *
 * The program is provider-agnostic - it yields the generic `EmbeddingModel`
 * tag, so swapping providers is a layer-level decision. Task semantics
 * vary: Jina v4 unifies query and document under `retrieval`; OpenAI
 * has no task field; `gemini-embedding-2` ignores it. For provider-
 * portable retrieval-quality work, use a model with a task field
 * (e.g. `gemini-embedding-001` or Jina v3/v5) and pass `task: "query"` /
 * `task: "document"`.
 */
import { Config, Effect, Layer, Logger, Match, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Embedding from "@effect-uai/core/Embedding"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Vector from "@effect-uai/core/Vector"
import { layer as geminiEmbeddingLayer } from "@effect-uai/google/GeminiEmbedding"
import { layer as jinaEmbeddingLayer } from "@effect-uai/jina/JinaEmbedding"
import { layer as openaiEmbeddingLayer } from "@effect-uai/responses/OpenAIEmbedding"

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
// Helpers
// ---------------------------------------------------------------------------

const asFloat32 = (e: Embedding.Embedding): Effect.Effect<Float32Array, AiError.AiError> =>
  Embedding.isFloat32(e)
    ? Effect.succeed(e.vector)
    : Effect.fail(
        new AiError.InvalidRequest({
          provider: "embedding",
          param: "encoding",
          raw: `expected float32 embedding, got "${e._tag}"`,
        }),
      )

// ---------------------------------------------------------------------------
// Program - provider-agnostic. Picks the model name as a parameter; the
// layer below decides which provider answers.
// ---------------------------------------------------------------------------

const program = (model: string) =>
  Effect.gen(function* () {
    // Query and documents are independent HTTP calls; run them in parallel.
    const [queryResult, docsResult] = yield* Effect.all(
      [embed({ model, input: query }), embedMany({ model, inputs: documents })],
      { concurrency: "unbounded" },
    )

    const qVec = yield* asFloat32(queryResult.embedding)
    const docVecs = yield* Effect.forEach(docsResult.embeddings, asFloat32)

    const ranked = documents
      .map((doc, i) => ({ doc, score: Vector.cosine(qVec, docVecs[i]!) }))
      .sort((a, b) => b.score - a.score)

    yield* Effect.logInfo("query", { query })
    yield* Effect.forEach(ranked, ({ doc, score }, i) =>
      Effect.logInfo(`#${i + 1}  score=${score.toFixed(4)}`, { doc }),
    )
  })

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

type Provider = "gemini" | "openai" | "jina"

const parseProvider = (argv: ReadonlyArray<string>): Provider => {
  const flag =
    argv.find((a) => a.startsWith("--provider="))?.slice("--provider=".length) ?? "gemini"
  return Match.value(flag).pipe(
    Match.when("gemini", () => "gemini" as const),
    Match.when("openai", () => "openai" as const),
    Match.when("jina", () => "jina" as const),
    Match.orElse(() => {
      throw new Error(`unknown provider: ${flag} (expected gemini|openai|jina)`)
    }),
  )
}

const modelFor = (provider: Provider): string =>
  Match.value(provider).pipe(
    Match.when("gemini", () => "gemini-embedding-2"),
    Match.when("openai", () => "text-embedding-3-small"),
    Match.when("jina", () => "jina-embeddings-v4"),
    Match.exhaustive,
  )

const layerFor = (provider: Provider) =>
  Match.value(provider).pipe(
    Match.when("gemini", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
          return geminiEmbeddingLayer({ apiKey })
        }),
      ),
    ),
    Match.when("openai", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("OPENAI_API_KEY")
          return openaiEmbeddingLayer({ apiKey })
        }),
      ),
    ),
    Match.when("jina", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("JINA_API_KEY")
          return jinaEmbeddingLayer({ apiKey })
        }),
      ),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const provider = parseProvider(process.argv.slice(2))

const mainLayer = Layer.mergeAll(
  layerFor(provider).pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program(modelFor(provider)).pipe(
    Effect.tap(() => Effect.logInfo(`provider: ${provider}`)),
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
