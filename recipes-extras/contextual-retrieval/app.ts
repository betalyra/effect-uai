/**
 * Composition + rendering for the contextual-retrieval recipe.
 *
 * Everything replaceable is wired here: the corpus (a Gutenberg book), the
 * chunker, the libsql store, Jina for embeddings and rerank, and the model
 * that writes the situating blurbs and the answers. `recipe.ts` sees none of it.
 *
 * `JINA_API_KEY` covers both retrieval stages. The blurbs need
 * `ANTHROPIC_API_KEY`, or `LLM_API_KEY` plus `--base-url` for a gateway.
 */
import { Array as Arr, Config, Effect, Layer, Logger, Option, References, Stdio } from "effect"
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { layer as jinaEmbeddingLayer } from "@effect-uai/jina/JinaEmbedding"
import { layer as jinaRerankerLayer } from "@effect-uai/jina/JinaReranker"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import * as Chunking from "@effect-uai/retrieval/Chunking"
// Shared with the in-workspace recipes: same flag parsing, same colours.
import { flagValue } from "../../recipes/_shared/argv.js"
import { cyan, dim } from "../../recipes/_shared/render.js"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { load } from "./corpus.js"
import { layer as libsqlLayer } from "./libsql.js"
import { answer, compare, type Cost, ingest, type Scored, type Stages } from "./recipe.js"

// Anchored to this folder, not the caller's cwd, so the database and the
// cached corpus land next to the recipe (where .gitignore covers them).
const HERE = dirname(fileURLToPath(import.meta.url))
const DB_URL = `file:${join(HERE, "rag.db")}`
const CACHE_PATH = join(HERE, "corpus.txt")

/**
 * Back-reference questions: the answering passage says "he" or "the house"
 * where the question says the name. That gap is what a situating blurb closes.
 */
const DEMO_QUESTIONS: ReadonlyArray<string> = [
  "What did the stepfather keep in his safe?",
  "How did the sisters know the doctor was coming down the corridor?",
  "Why could the bell-rope not ring anything?",
]

const num = (name: string, argv: ReadonlyArray<string>, fallback: number): number =>
  Option.match(flagValue(name, argv), {
    onNone: () => fallback,
    onSome: (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : fallback),
  })

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const asked = Option.orElse(flagValue("question", argv), () =>
    Arr.findFirst(argv, (a) => !a.startsWith("--")),
  )
  return {
    questions: Option.match(asked, {
      onNone: () => DEMO_QUESTIONS,
      onSome: (q) => [q],
    }),
    model: Option.getOrElse(flagValue("model", argv), () => "claude-haiku-4-5-20251001"),
    // Set it to route through a gateway instead of Anthropic directly. Costs
    // you prompt caching, which is what keeps the indexing pass affordable.
    baseUrl: flagValue("base-url", argv),
    embedModel: Option.getOrElse(flagValue("embed-model", argv), () => "jina-embeddings-v4"),
    rerankModel: Option.getOrElse(flagValue("rerank-model", argv), () => "jina-reranker-v3.5"),
    perLeg: num("per-leg", argv, 100),
    rerankDepth: num("rerank-depth", argv, 20),
    keep: num("keep", argv, 5),
    // Matryoshka truncation: 2048-dim vectors make the index enormous, and we
    // build two of them here.
    dimensions: num("dimensions", argv, 512),
    concurrency: num("concurrency", argv, 4),
  }
})

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

const clip = (s: string, max = 58) =>
  (s.length <= max ? s : `${s.slice(0, max - 1)}…`).replace(/\s+/g, " ")

const indent = (text: string): string =>
  Arr.map(text.split("\n"), (line) => `    ${line}`).join("\n")

const pct = (part: number, whole: number): string =>
  whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`

/** Where a passage placed in the fused list, before reranking. */
const fusedRank = (stages: Stages, id: number): Option.Option<number> =>
  Arr.findFirstIndex(stages.fused, (f) => f.value === id).pipe(Option.map((i) => i + 1))

/**
 * How a passage fared in the other index. This is the comparison: a passage
 * the contextual index ranks 2nd and the plain index never retrieved at all is
 * the technique working.
 */
const movement = (other: Stages, id: number): string =>
  Option.match(
    Arr.findFirstIndex(other.reranked, (p) => p.id === id),
    {
      onSome: (i) => `was #${i + 1}`,
      onNone: () =>
        Option.match(fusedRank(other, id), {
          onSome: (rank) => `fused #${rank}, not kept`,
          onNone: () => "NOT RETRIEVED",
        }),
    },
  )

const table = (heading: string, stages: Stages, other: Stages) =>
  write(
    [
      `\n  ${cyan(heading)}`,
      ...Arr.map(
        stages.reranked,
        (p: Scored, i) =>
          `   ${String(i + 1).padStart(2)}. ${p.score.toFixed(4)}  #${String(p.id).padEnd(4)} ${clip(
            p.text,
          )}\n       ${dim(movement(other, p.id))}`,
      ),
      "",
    ].join("\n"),
  )

const costLine = (chunks: number, cost: Cost) =>
  write(
    [
      dim(`\nindexing cost: ${chunks} chunks, one LLM call each`),
      dim(
        `  input ${cost.inputTokens.toLocaleString()} tokens, of which ${cost.cachedTokens.toLocaleString()} cache reads (${pct(
          cost.cachedTokens,
          cost.inputTokens,
        )})`,
      ),
      dim(
        `  cache writes ${cost.cacheWriteTokens.toLocaleString()}, output ${cost.outputTokens.toLocaleString()}`,
      ),
      "",
    ].join("\n"),
  )

/**
 * Anthropic by default, because the whole document rides in every situating
 * call and its prompt cache is what makes that affordable. `--base-url` swaps
 * in any OpenAI-compatible gateway, for a cheaper model or a quick trial run.
 */
const languageModel = (flags: { readonly baseUrl: Option.Option<string> }) =>
  Option.match(flags.baseUrl, {
    onNone: () =>
      Effect.flatMap(Config.redacted("ANTHROPIC_API_KEY"), (apiKey) =>
        makeAnthropic({ apiKey, promptCaching: true }),
      ),
    onSome: (baseUrl) =>
      Effect.flatMap(Config.redacted("LLM_API_KEY"), (apiKey) =>
        makeResponses({ apiKey, baseUrl }),
      ),
  })

export const main = Effect.gen(function* () {
  const flags = yield* readFlags
  const model = yield* languageModel(flags)

  yield* write(dim("\nloading corpus…\n"))
  const document = yield* load(CACHE_PATH)

  // The first run pays one LLM call per chunk. Say so while it happens.
  const { chunks, cost, ingested } = yield* ingest(document, {
    embedModel: flags.embedModel,
    contextModel: flags.model,
    dimensions: flags.dimensions,
    concurrency: flags.concurrency,
    onChunked: (total) => write(dim(`chunked into ${total} passages\n`)),
    // The situating pass is one LLM call per chunk and takes minutes. Say so
    // rather than sitting silent.
    onContext: (done, total) =>
      write(dim(`\r  situated ${done}/${total} chunks`)).pipe(
        Effect.andThen(done === total ? write("\n") : Effect.void),
      ),
    onProgress: (done, total) =>
      write(dim(`\r  embedded ${done}/${total} chunks`)).pipe(
        Effect.andThen(done === total ? write("\n") : Effect.void),
      ),
  }).pipe(Effect.provideService(LanguageModel, model))

  yield* ingested
    ? costLine(chunks, cost)
    : write(dim(`${chunks} chunks already indexed, both variants\n`))

  const searchOptions = {
    embedModel: flags.embedModel,
    rerankModel: flags.rerankModel,
    dimensions: flags.dimensions,
    perLeg: flags.perLeg,
    rerankDepth: flags.rerankDepth,
    keep: flags.keep,
  }

  yield* Effect.forEach(
    flags.questions,
    (question) =>
      Effect.gen(function* () {
        yield* write(`\n${"─".repeat(72)}\n${cyan("question")}  ${question}\n`)

        const { contextual, plain } = yield* compare(question, searchOptions)
        yield* table("plain index", plain, contextual)
        yield* table("contextual index", contextual, plain)

        const [plainAnswer, contextualAnswer] = yield* Effect.all(
          [
            answer(question, plain.reranked, flags.model),
            answer(question, contextual.reranked, flags.model),
          ],
          { concurrency: 2 },
        ).pipe(Effect.provideService(LanguageModel, model))
        yield* write(`  ${cyan("answer from plain")}\n${indent(plainAnswer)}\n`)
        yield* write(`  ${cyan("answer from contextual")}\n${indent(contextualAnswer)}\n`)
      }),
    { discard: true },
  )
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))

export const appLayer = Layer.mergeAll(
  libsqlLayer(DB_URL),
  // Identical to agentic-search's chunker and parameters: contextualization has to
  // be the only difference between the two recipes.
  Chunking.layer(Chunking.sentences, { targetSize: 512, overlap: 64 }),
  Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("JINA_API_KEY")
      return Layer.merge(jinaEmbeddingLayer({ apiKey }), jinaRerankerLayer({ apiKey }))
    }),
  ),
  Logger.layer([Logger.consolePretty()]),
  Layer.unwrap(
    Effect.gen(function* () {
      const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
      return Layer.succeed(References.MinimumLogLevel, level)
    }),
  ),
)
