/**
 * Composition + rendering for the retrieve-and-rerank recipe.
 *
 * `JINA_API_KEY` covers both retrieval stages (embeddings and rerank are the
 * same key). The grounded answer needs a language model, so `LLM_API_KEY` is
 * read separately; without it the recipe still prints the before/after
 * ranking, which is the part worth looking at.
 */
import { Config, Effect, Layer, Logger, Option, References, Stdio, Stream } from "effect"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { layer as jinaEmbeddingLayer } from "@effect-uai/jina/JinaEmbedding"
import { layer as jinaRerankerLayer } from "@effect-uai/jina/JinaReranker"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { flagValue } from "../_shared/argv.js"
import { cyan, dim, renderEvent } from "../_shared/render.js"
import { documents, questions } from "./corpus.js"
import { answer, type Ranked, retrieve } from "./recipe.js"

type Flags = {
  readonly question: string
  readonly model: string
  readonly baseUrl: string
  readonly embedModel: string
  readonly rerankModel: string
  readonly candidates: number
  readonly keep: number
}

const intFlag = (name: string, argv: ReadonlyArray<string>, fallback: number): number =>
  Option.match(flagValue(name, argv), {
    onNone: () => fallback,
    onSome: (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : fallback),
  })

const readFlags: Effect.Effect<Flags, never, Stdio.Stdio> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    question: Option.getOrElse(flagValue("question", argv), () => questions[0]!),
    model: Option.getOrElse(flagValue("model", argv), () => "openai/gpt-4o-mini"),
    baseUrl: Option.getOrElse(flagValue("base-url", argv), () => "https://openrouter.ai/api/v1"),
    embedModel: Option.getOrElse(flagValue("embed-model", argv), () => "jina-embeddings-v4"),
    rerankModel: Option.getOrElse(flagValue("rerank-model", argv), () => "jina-reranker-v3.5"),
    candidates: intFlag("candidates", argv, 15),
    keep: intFlag("keep", argv, 4),
  }
})

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

// Keep a rendered row inside 80 columns so the tables do not soft-wrap.
const clip = (s: string, max = 62) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

/**
 * The showcase: the same candidates ordered by each stage, and the margin
 * between the top two. Cosine bunches its scores; the reranker separates them.
 */
const table = (heading: string, rows: ReadonlyArray<Ranked>, kept: ReadonlySet<number>) => {
  const margin = rows.length < 2 ? undefined : Math.abs(rows[0]!.score - rows[1]!.score).toFixed(4)
  return write(
    [
      `\n${cyan(heading)}`,
      ...rows.map((r, i) => {
        const line = `  ${String(i + 1).padStart(2)}. ${r.score.toFixed(4)}  ${clip(documents[r.id]!)}`
        return kept.has(r.id) ? line : dim(line)
      }),
      ...(margin === undefined ? [] : [dim(`      top-1 margin ${margin}`)]),
      "",
    ].join("\n"),
  )
}

export const main = Effect.gen(function* () {
  const flags = yield* readFlags
  yield* write(`\n${cyan("question")}  ${flags.question}\n`)

  const { cosine, reranked } = yield* retrieve({
    query: flags.question,
    documents,
    embedModel: flags.embedModel,
    rerankModel: flags.rerankModel,
    candidates: flags.candidates,
    keep: flags.keep,
  })

  // Highlight the documents the reranker promoted into the answer set.
  const kept = new Set(reranked.map((r) => r.id))
  yield* table(
    `by cosine (top ${Math.min(flags.keep + 3, cosine.length)} of ${cosine.length} candidates)`,
    cosine.slice(0, flags.keep + 3),
    kept,
  )
  yield* table(`after rerank (top ${reranked.length})`, reranked, kept)

  const context = reranked.map((r) => documents[r.id]!)
  const apiKey = yield* Config.redacted("LLM_API_KEY").pipe(Effect.option)

  yield* Option.match(apiKey, {
    onNone: () => write(dim("\nSet LLM_API_KEY to also generate the grounded answer.\n")),
    onSome: (key) =>
      Effect.gen(function* () {
        yield* write(`\n${cyan("answer")}\n`)
        const model = yield* makeResponses({ apiKey: key, baseUrl: flags.baseUrl })
        yield* Stream.runForEach(
          answer({ question: flags.question, model: flags.model, context }),
          renderEvent(),
        ).pipe(Effect.provideService(LanguageModel, model))
      }),
  })
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))

export const appLayer = Layer.mergeAll(
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
