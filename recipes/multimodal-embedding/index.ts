/**
 * Cross-modal retrieval. Embed a query image alongside a corpus mixing
 * images and text in one batch, then rank by cosine similarity.
 *
 *   pnpm tsx recipes/multimodal-embedding/index.ts
 *
 * Requires `GOOGLE_API_KEY` in the environment.
 *
 * Uses `gemini-embedding-2` - Google's GA multimodal embedding model.
 * Images come from Unsplash via the `/download?force=true` redirect URL,
 * which is stable and follows redirects to the CDN.
 *
 * The recipe also exercises mixed-modality batching: `embedMany` accepts
 * a `ReadonlyArray<EmbedInput>` where each entry can be text, image, or a
 * mixed `content[]`. One HTTP call covers them all.
 */
import { Config, Effect, Layer, Logger, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Embedding from "@effect-uai/core/Embedding"
import type { EmbedInput } from "@effect-uai/core/Embedding"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Image from "@effect-uai/core/Image"
import * as Vector from "@effect-uai/core/Vector"
import { layer as geminiEmbeddingLayer } from "@effect-uai/google/GeminiEmbedding"

// ---------------------------------------------------------------------------
// Corpus - one image as the query, a mixed-modality batch as the corpus.
// Cross-modal expectation: bread-bowl image (query) should cosine-rank
// the dough-making image and bread/croissant text near the top, and the
// dragon image / dragon-statue text near the bottom.
// ---------------------------------------------------------------------------

interface ImageItem {
  readonly kind: "image"
  readonly label: string
  readonly url: string
}
interface TextItem {
  readonly kind: "text"
  readonly text: string
}
type Item = ImageItem | TextItem

// Direct CDN URLs from Unsplash. Photos by Monika Grabkowska (mixing bowl),
// Nadya Spetnitskaya (dough), and Eva Bronzini (dragon). Free under the
// Unsplash License - commercial use, no attribution required.
const queryImage: ImageItem = {
  kind: "image",
  label: "mixing-bowl",
  url: "https://images.unsplash.com/photo-1540660290370-8aa90e451e8a?fm=jpg&w=1200",
}

const documents: ReadonlyArray<Item> = [
  {
    kind: "image",
    label: "dough",
    url: "https://images.unsplash.com/photo-1517686469429-8bdb88b9f907?fm=jpg&w=1200",
  },
  {
    kind: "image",
    label: "dragon",
    url: "https://images.unsplash.com/photo-1565457210787-a4e17b40f04e?fm=jpg&w=1200",
  },
  { kind: "text", text: "A photo of artisan sourdough bread" },
  { kind: "text", text: "A landscape painting of mountains" },
  { kind: "text", text: "A car driving on the highway" },
  { kind: "text", text: "A delicious croissant on a plate" },
  { kind: "text", text: "A fierce dragon statue" },
]

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const fetchBytes = (url: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, { redirect: "follow" })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
      return new Uint8Array(await res.arrayBuffer())
    },
    catch: (cause) => new AiError.Unavailable({ provider: "fetch", raw: cause }),
  })

// ---------------------------------------------------------------------------
// Item -> EmbedInput (text passes through, images get fetched as bytes)
// ---------------------------------------------------------------------------

const itemToEmbedInput = (item: Item): Effect.Effect<EmbedInput, AiError.AiError> =>
  item.kind === "text"
    ? Effect.succeed({ text: item.text })
    : fetchBytes(item.url).pipe(
        Effect.map(
          (bytes): EmbedInput => ({
            image: Image.imageBytes(bytes, "image/jpeg"),
          }),
        ),
      )

const itemLabel = (item: Item): string =>
  item.kind === "text" ? `text: ${item.text}` : `image: ${item.label}`

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
  // Resolve all inputs in parallel: image fetches and text passthroughs.
  const queryInput = yield* itemToEmbedInput(queryImage)
  const docInputs = yield* Effect.forEach(documents, itemToEmbedInput, {
    concurrency: "unbounded",
  })

  // Embed query and the mixed-modality batch in parallel.
  const [queryResult, docsResult] = yield* Effect.all(
    [embed({ model, input: queryInput }), embedMany({ model, inputs: docInputs })],
    { concurrency: "unbounded" },
  )

  const qVec = yield* asFloat32(queryResult.embedding)
  const docVecs = yield* Effect.forEach(docsResult.embeddings, asFloat32)

  const ranked = documents
    .map((item, i) => ({ label: itemLabel(item), score: Vector.cosine(qVec, docVecs[i]!) }))
    .sort((a, b) => b.score - a.score)

  yield* Effect.logInfo(`query: ${itemLabel(queryImage)}`)
  yield* Effect.forEach(ranked, ({ label, score }, i) =>
    Effect.logInfo(`#${i + 1}  score=${score.toFixed(4)}`, { label }),
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
