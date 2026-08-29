/**
 * Hybrid search as a tool the agent calls, not context stuffed into a prompt.
 * This is the file to copy into your own project.
 *
 * The model decides when to search and what to search for, so it can rephrase
 * and search again when the first query misses. Each call runs two retrieval
 * legs (lexical and dense), fuses them by rank, and reranks the fused head, so
 * every hop is cheap and precise.
 *
 * It depends on one port you implement for your setup, `ChunkStore`, plus the
 * generic effect-uai capability tags. Nothing here knows about libsql, Jina,
 * or any particular chunking strategy: `libsql.ts` is this demo's
 * implementation of the port, and `app.ts` picks the chunker.
 */
import { Array as Arr, Context, Effect, pipe, Schema } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import { chunk as splitDocument } from "@effect-uai/core/Chunker"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import { rerank } from "@effect-uai/core/Reranker"
import * as Rank from "@effect-uai/retrieval/Rank"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A stored chunk, addressed by the id the store gave it. */
export type Passage = {
  readonly id: number
  readonly text: string
}

/** A passage with the score of whichever leg returned it. Higher is better. */
export type Scored = Passage & {
  readonly score: number
}

/**
 * The store behind both retrieval legs. Implement it against whatever you
 * already run: this demo uses one libsql file, but pgvector plus a `tsvector`
 * column, or Qdrant plus OpenSearch, satisfy the same contract.
 */
export type ChunkStoreService = {
  readonly count: Effect.Effect<number>
  readonly add: (
    rows: ReadonlyArray<{ readonly text: string; readonly embedding: Float32Array }>,
  ) => Effect.Effect<void>
  /** Vector KNN against the query embedding. */
  readonly dense: (query: Float32Array, limit: number) => Effect.Effect<ReadonlyArray<Scored>>
  /** Full-text search, best first. */
  readonly lexical: (query: string, limit: number) => Effect.Effect<ReadonlyArray<Scored>>
}

export class ChunkStore extends Context.Service<ChunkStore, ChunkStoreService>()(
  "agentic-search/ChunkStore",
) {}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export type IngestOptions = {
  readonly embedModel: string
  /** Chunks per embedding call. Default 64. */
  readonly batchSize?: number
  /**
   * Truncate embeddings to this many dimensions. Storage and index size are
   * linear in it, so a smaller vector is worth trying before a bigger disk.
   */
  readonly dimensions?: number
  /** Called after each batch is stored, for progress reporting. */
  readonly onProgress?: (done: number, total: number) => Effect.Effect<void>
}

/**
 * Chunk, embed, store. Idempotent: a store that already holds chunks is left
 * alone, so re-running does not re-embed the corpus. Batches are written one
 * after another; some vector indexes (libsql's included) reject concurrent
 * writers.
 */
export const ingest = (text: string, options: IngestOptions) =>
  Effect.gen(function* () {
    const store = yield* ChunkStore
    const existing = yield* store.count
    if (existing > 0) return { chunks: existing, ingested: false }

    const chunks = yield* splitDocument(text)
    const batches = Arr.chunksOf(
      Arr.map(chunks, (c) => c.text),
      options.batchSize ?? 64,
    )

    yield* Effect.forEach(
      batches,
      (batch, i) =>
        embedMany({
          model: options.embedModel,
          inputs: batch,
          task: "document",
          ...(options.dimensions !== undefined && { dimensions: options.dimensions }),
        }).pipe(
          Effect.flatMap((result) =>
            store.add(
              Arr.map(batch, (text, i) => ({ text, embedding: result.embeddings[i]!.vector })),
            ),
          ),
          Effect.andThen(
            options.onProgress?.(
              Math.min((i + 1) * (options.batchSize ?? 64), chunks.length),
              chunks.length,
            ) ?? Effect.void,
          ),
        ),
      { discard: true },
    )

    return { chunks: chunks.length, ingested: true }
  })

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

export type SearchOptions = {
  readonly embedModel: string
  readonly rerankModel: string
  /** Must match the dimension the corpus was ingested at. */
  readonly dimensions?: number
  /** Candidates per retrieval leg. Default 100. */
  readonly perLeg?: number
  /** Fused candidates handed to the reranker. Default 20. */
  readonly rerankDepth?: number
  /** Passages returned to the model. Default 5. */
  readonly keep?: number
  readonly denseWeight?: number
  readonly lexicalWeight?: number
}

/** Every stage, so a caller can show its work. */
export type Stages = {
  readonly query: string
  readonly dense: ReadonlyArray<Scored>
  readonly lexical: ReadonlyArray<Scored>
  readonly fused: ReadonlyArray<Rank.Fused<number>>
  readonly reranked: ReadonlyArray<Scored>
}

export const hybridSearch = (query: string, options: SearchOptions) =>
  Effect.gen(function* () {
    const store = yield* ChunkStore
    const perLeg = options.perLeg ?? 100

    // `task: "query"` matters: retrieval-tuned models encode a question and
    // the passage answering it differently.
    const queryVector = yield* embed({
      model: options.embedModel,
      input: query,
      task: "query",
      ...(options.dimensions !== undefined && { dimensions: options.dimensions }),
    }).pipe(Effect.map((r) => r.embedding.vector))

    const dense = yield* store.dense(queryVector, perLeg)
    const lexical = yield* store.lexical(query, perLeg)

    // Fuse by position, not by score: BM25 and cosine are incomparable scales.
    const fused = Rank.rrf([Arr.map(dense, (d) => d.id), Arr.map(lexical, (l) => l.id)], {
      weights: [options.denseWeight ?? 1, options.lexicalWeight ?? 1],
    })

    // Every fused id came from one of the legs, so their rows already carry
    // the text: no second round trip to the store.
    const texts = new Map([...dense, ...lexical].map((c): [number, string] => [c.id, c.text]))
    const candidates = Arr.take(fused, options.rerankDepth ?? 20)
      .map((f) => ({ id: f.value, text: texts.get(f.value) }))
      .filter((c): c is Passage => c.text !== undefined)

    const { results } = yield* rerank({
      model: options.rerankModel,
      query,
      documents: Arr.map(candidates, (c) => c.text),
      topN: options.keep ?? 5,
    })

    // `results[].index` addresses the list we sent, not the store.
    const reranked = Arr.map(results, (r): Scored => ({ ...candidates[r.index]!, score: r.score }))

    return { query, dense, lexical, fused, reranked } satisfies Stages
  })

const SearchInput = Schema.Struct({
  query: Schema.String,
})

export type SearchToolOptions = SearchOptions & {
  /** Called with every stage of each search. Use it to trace the pipeline. */
  readonly onStages?: (stages: Stages) => Effect.Effect<void>
}

/**
 * The retrieval hop, as a tool. The model gets passage ids and text back and
 * decides whether to search again or answer.
 */
export const searchTool = (options: SearchToolOptions) =>
  Tool.make({
    name: "search_corpus",
    description:
      "Search the indexed corpus for passages relevant to a query. Combines keyword and semantic search. Call it more than once with different phrasings if the first results are thin.",
    inputSchema: Tool.fromEffectSchema(SearchInput),
    run: ({ query }) =>
      hybridSearch(query, options).pipe(
        Effect.tap((stages) => options.onStages?.(stages) ?? Effect.void),
        Effect.map((stages) => ({
          passages: Arr.map(stages.reranked, (p) => ({ id: p.id, text: p.text })),
        })),
      ),
    strict: true,
  })

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You answer questions about a corpus you can only reach through the search_corpus tool.",
  "",
  "- Search before answering. Do not answer from prior knowledge.",
  "- If the first results do not cover the question, search again with different wording.",
  "- Cite the passage ids you used, e.g. (id 42).",
  "- If the corpus does not answer the question, say so plainly.",
].join("\n")

type State = {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly round: number
}

export type AgentConfig = {
  readonly question: string
  readonly model: string
  /** Hard cap on model turns. The last round withholds the tool. Default 4. */
  readonly maxRounds?: number
  readonly search: SearchToolOptions
}

export const agent = (cfg: AgentConfig) => {
  const maxRounds = cfg.maxRounds ?? 4
  // Retrieval failures are typed on `AiError`; describing them lets the agent
  // adapt (search again, answer with what it has) instead of the run ending.
  const toolkit = Toolkit.describeFailures(Toolkit.make(searchTool(cfg.search)), AiError.describe)

  const initial: State = {
    history: [Items.systemText(SYSTEM_PROMPT), Items.userText(cfg.question)],
    round: 0,
  }

  return pipe(
    initial,
    loop((state: State) => {
      const lastRound = state.round >= maxRounds
      return Effect.succeed(
        streamTurn({
          history: state.history,
          model: cfg.model,
          ...(lastRound ? {} : { tools: toolkit }),
        }).pipe(
          onTurnComplete((turn) =>
            Effect.sync(() => {
              const calls = lastRound ? [] : Turn.getToolCalls(turn)
              if (calls.length === 0) return stop()
              return Toolkit.run(toolkit, calls).pipe(
                Toolkit.continueWithResults(
                  Toolkit.appendToolResults({ ...state, round: state.round + 1 }, turn),
                ),
              )
            }),
          ),
        ),
      )
    }),
  )
}
