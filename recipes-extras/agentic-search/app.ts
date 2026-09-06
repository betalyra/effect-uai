/**
 * Composition + rendering for the agentic-search recipe.
 *
 * Everything replaceable is wired here: the corpus (a Gutenberg book), the
 * chunker, the libsql store, Jina for embeddings and rerank, and a
 * gateway-hosted model for the agent. `recipe.ts` sees none of it.
 *
 * `JINA_API_KEY` covers both retrieval stages; `LLM_API_KEY` runs the agent.
 */
import { Array as Arr, Config, Effect, Layer, Option, Stdio, Stream } from "effect"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { layer as jinaEmbeddingLayer } from "@effect-uai/jina/JinaEmbedding"
import { layer as jinaRerankerLayer } from "@effect-uai/jina/JinaReranker"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import * as Chunking from "@effect-uai/retrieval/Chunking"
// Shared with the in-workspace recipes: same flag parsing, same renderer.
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { cyan, dim, renderEvent } from "@effect-uai/recipe-kit/render"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { load } from "./corpus.js"
import { layer as libsqlLayer } from "./libsql.js"
import { agent, ingest, type Stages } from "./recipe.js"

// Anchored to this folder, not the caller's cwd, so the database and the
// cached corpus land next to the recipe (where .gitignore covers them).
const HERE = dirname(fileURLToPath(import.meta.url))
const DB_URL = `file:${join(HERE, "rag.db")}`
const CACHE_PATH = join(HERE, "corpus.txt")

const num = (name: string, argv: ReadonlyArray<string>, fallback: number): number =>
  Option.match(flagValue(name, argv), {
    onNone: () => fallback,
    onSome: (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : fallback),
  })

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    // A bare argument is the question, so `run.ts "why ...?"` works.
    question: Option.getOrElse(
      Option.orElse(flagValue("question", argv), () =>
        Arr.findFirst(argv, (a) => !a.startsWith("--")),
      ),
      () => "Why does the speckled band kill?",
    ),
    model: Option.getOrElse(flagValue("model", argv), () => "openai/gpt-4o-mini"),
    baseUrl: Option.getOrElse(flagValue("base-url", argv), () => "https://openrouter.ai/api/v1"),
    embedModel: Option.getOrElse(flagValue("embed-model", argv), () => "jina-embeddings-v4"),
    rerankModel: Option.getOrElse(flagValue("rerank-model", argv), () => "jina-reranker-v3.5"),
    perLeg: num("per-leg", argv, 100),
    rerankDepth: num("rerank-depth", argv, 20),
    keep: num("keep", argv, 5),
    denseWeight: num("dense-weight", argv, 1),
    lexicalWeight: num("bm25-weight", argv, 1),
    // 2048-dim vectors make the index enormous for a demo corpus; Matryoshka
    // truncation keeps recall and shrinks the file by 4x.
    dimensions: num("dimensions", argv, 512),
  }
})

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

const clip = (s: string, max = 96) =>
  (s.length <= max ? s : `${s.slice(0, max - 1)}…`).replace(/\s+/g, " ")

/**
 * The stage trace is the showcase: what each leg found, what fusion made of
 * the two lists, and what survived the reranker.
 */
const renderStages = (stages: Stages): Effect.Effect<void> => {
  const inDense = new Set(stages.dense.map((d) => d.id))
  const inLexical = new Set(stages.lexical.map((l) => l.id))
  const legs = (id: number) => `${inDense.has(id) ? "d" : "-"}${inLexical.has(id) ? "l" : "-"}`

  return write(
    [
      dim(
        `\n   dense ${stages.dense.length} · lexical ${stages.lexical.length} · fused ${stages.fused.length}`,
      ),
      dim("   fused top 10 (d = dense leg, l = lexical leg)"),
      ...Arr.map(Arr.take(stages.fused, 10), (f, i) =>
        dim(
          `     ${String(i + 1).padStart(2)}. [${legs(f.value)}] ${f.score.toFixed(5)}  #${f.value}`,
        ),
      ),
      cyan(`   reranked top ${stages.reranked.length}`),
      ...Arr.map(stages.reranked, (p, i) =>
        dim(`     ${String(i + 1).padStart(2)}. ${p.score.toFixed(4)}  #${p.id}  ${clip(p.text)}`),
      ),
      "",
    ].join("\n"),
  )
}

const services = Layer.mergeAll(
  libsqlLayer(DB_URL),
  // Sentence packing keeps a passage readable; swap in `Chunking.markdown` or
  // a hosted chunker without touching `recipe.ts`.
  Chunking.layer(Chunking.sentences, { targetSize: 512, overlap: 64 }),
  Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("JINA_API_KEY")
      return Layer.merge(jinaEmbeddingLayer({ apiKey }), jinaRerankerLayer({ apiKey }))
    }),
  ),
)

export const main = Effect.gen(function* () {
  const flags = yield* readFlags

  // The first run downloads and embeds a whole book, so say what is happening
  // rather than sitting silent for minutes.
  yield* write(dim("\nloading corpus…\n"))
  const text = yield* load(CACHE_PATH)

  const { chunks, ingested } = yield* ingest(text, {
    embedModel: flags.embedModel,
    dimensions: flags.dimensions,
    onProgress: (done, total) =>
      write(dim(`\r  embedded ${done}/${total} chunks`)).pipe(
        Effect.andThen(done === total ? write("\n") : Effect.void),
      ),
  })
  yield* write(dim(ingested ? `ingested ${chunks} chunks\n` : `${chunks} chunks already indexed\n`))
  yield* write(`\n${cyan("question")}  ${flags.question}\n`)

  const apiKey = yield* Config.redacted("LLM_API_KEY")
  const model = yield* makeResponses({ apiKey, baseUrl: flags.baseUrl })

  yield* Stream.runForEach(
    agent({
      question: flags.question,
      model: flags.model,
      search: {
        embedModel: flags.embedModel,
        rerankModel: flags.rerankModel,
        dimensions: flags.dimensions,
        perLeg: flags.perLeg,
        rerankDepth: flags.rerankDepth,
        keep: flags.keep,
        denseWeight: flags.denseWeight,
        lexicalWeight: flags.lexicalWeight,
        onStages: renderStages,
      },
    }),
    // The tool result is the passages, already shown by `renderStages`.
    renderEvent({ maxResultChars: 0 }),
  ).pipe(Effect.provideService(LanguageModel, model))
}).pipe(
  Effect.provide(services),
  Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })),
)
