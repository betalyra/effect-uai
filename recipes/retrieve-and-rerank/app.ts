/**
 * Composition + rendering for the retrieve-and-rerank recipe.
 *
 * Three model specs, one per stage: `--embed-model`, `--rerank-model` and
 * `--model` for the grounded answer, each resolved to a Layer by
 * `_shared/model.ts`. Without a key for the answer model the recipe still
 * prints the before/after ranking, which is the part worth looking at.
 */
import { Effect, Layer, Option, Stdio, Stream } from "effect"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import {
  embeddingModelLayer,
  languageModelLayer,
  type ModelSpec,
  parseModelSpec,
  rerankerLayer,
} from "../_shared/model.js"
import { cyan, dim, renderEvent } from "@effect-uai/recipe-kit/render"
import { documents, questions } from "./corpus.js"
import { answer, type Ranked, retrieve } from "./recipe.js"

type Flags = {
  readonly question: string
  readonly model: ModelSpec
  readonly embed: ModelSpec
  readonly rerank: ModelSpec
  readonly candidates: number
  readonly keep: number
}

const readFlags: Effect.Effect<Flags, never, Stdio.Stdio> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    question: Option.getOrElse(flagValue("question", argv), () => questions[0]!),
    model: parseModelSpec(
      Option.getOrElse(flagValue("model", argv), () => "openai/gpt-4o-mini"),
      "openrouter",
    ),
    embed: parseModelSpec(
      Option.getOrElse(flagValue("embed-model", argv), () => "jina-embeddings-v4"),
      "jina",
    ),
    rerank: parseModelSpec(
      Option.getOrElse(flagValue("rerank-model", argv), () => "jina-reranker-v3.5"),
      "jina",
    ),
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
    embedModel: flags.embed.model,
    rerankModel: flags.rerank.model,
    candidates: flags.candidates,
    keep: flags.keep,
  }).pipe(
    Effect.provide(Layer.merge(embeddingModelLayer(flags.embed), rerankerLayer(flags.rerank))),
  )

  // Highlight the documents the reranker promoted into the answer set.
  const kept = new Set(reranked.map((r) => r.id))
  yield* table(
    `by cosine (top ${Math.min(flags.keep + 3, cosine.length)} of ${cosine.length} candidates)`,
    cosine.slice(0, flags.keep + 3),
    kept,
  )
  yield* table(`after rerank (top ${reranked.length})`, reranked, kept)

  // The ranking above is the point of the recipe, so a missing answer-model
  // key is a note rather than a failure.
  const context = reranked.map((r) => documents[r.id]!)
  yield* write(`\n${cyan("answer")}\n`)
  yield* Stream.runForEach(
    answer({ question: flags.question, model: flags.model.model, context }),
    renderEvent(),
  ).pipe(
    Effect.provide(languageModelLayer(flags.model)),
    Effect.catchTag("ConfigError", () =>
      write(dim("(set the answer model's API key to also generate the grounded answer)\n")),
    ),
  )
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
