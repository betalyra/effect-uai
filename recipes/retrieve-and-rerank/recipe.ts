/**
 * Two-stage retrieval: cosine picks the candidates, a reranker picks the
 * answer. Embedding similarity ranks documents that are *about* the query
 * near the top; a cross-encoder reads the query and each candidate together
 * and ranks the one that *answers* it.
 *
 * `recipe.ts` is the runtime-agnostic logic against the generic
 * `EmbeddingModel`, `Reranker` and `LanguageModel` tags; `app.ts` picks the
 * providers and the runners supply the platform HttpClient.
 */
import { Array as Arr, Effect, Order, pipe } from "effect"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import { rerank } from "@effect-uai/core/Reranker"
import * as Vector from "@effect-uai/core/Vector"

/** A corpus position and the score that put it there. */
export type Ranked = {
  readonly id: number
  readonly score: number
}

export type Retrieval = {
  readonly cosine: ReadonlyArray<Ranked>
  readonly reranked: ReadonlyArray<Ranked>
}

export type RetrieveConfig = {
  readonly query: string
  readonly documents: ReadonlyArray<string>
  readonly embedModel: string
  readonly rerankModel: string
  /** Candidates the reranker sees. Default 15. */
  readonly candidates?: number
  /** Documents kept for the answer. Default 4. */
  readonly keep?: number
}

const byScore = Order.mapInput(Order.flip(Order.Number), (r: Ranked) => r.score)

/**
 * Embed with `task: "query"` / `task: "document"`: retrieval-tuned models
 * encode a question and the passage answering it differently, and skipping
 * the hint measurably costs recall.
 */
export const retrieve = (cfg: RetrieveConfig) =>
  Effect.gen(function* () {
    const [queryResult, docsResult] = yield* Effect.all(
      [
        embed({ model: cfg.embedModel, input: cfg.query, task: "query" }),
        embedMany({ model: cfg.embedModel, inputs: cfg.documents, task: "document" }),
      ],
      { concurrency: "unbounded" },
    )

    const queryVector = queryResult.embedding.vector
    const cosine = pipe(
      docsResult.embeddings,
      Arr.map((e, id): Ranked => ({ id, score: Vector.cosine(queryVector, e.vector) })),
      Arr.sort(byScore),
      Arr.take(cfg.candidates ?? 15),
    )

    const { results } = yield* rerank({
      model: cfg.rerankModel,
      query: cfg.query,
      documents: Arr.map(cosine, (c) => cfg.documents[c.id]!),
      topN: cfg.keep ?? 4,
    })

    // `results[].index` addresses the candidate list we sent, not the corpus.
    const reranked = Arr.map(results, (r): Ranked => ({
      id: cosine[r.index]!.id,
      score: r.score,
    }))

    return { cosine, reranked } satisfies Retrieval
  })

const SYSTEM_PROMPT = [
  "Answer the question using only the numbered context below.",
  "Cite the numbers you used, e.g. (1). If the context does not answer the question, say so.",
  "Be brief: two sentences at most.",
].join("\n")

const withContext = (context: ReadonlyArray<string>): string =>
  [SYSTEM_PROMPT, "", ...Arr.map(context, (text, i) => `${i + 1}. ${text}`)].join("\n")

export type AnswerConfig = {
  readonly question: string
  readonly model: string
  readonly context: ReadonlyArray<string>
}

/** One grounded turn. No tools, so the loop stops as soon as the model answers. */
export const answer = (cfg: AnswerConfig) =>
  pipe(
    {
      history: [Items.systemText(withContext(cfg.context)), Items.userText(cfg.question)],
    },
    loop((state) =>
      Effect.succeed(
        streamTurn({ history: state.history, model: cfg.model }).pipe(
          onTurnComplete(() => Effect.succeed(stop())),
        ),
      ),
    ),
  )
