/**
 * Contextual retrieval: at indexing time an LLM reads the whole document and
 * writes a sentence or two situating each chunk, and that blurb is prepended
 * before both the embedding and the keyword indexing. This is the file to copy
 * into your own project.
 *
 * It builds two indexes over the same chunks, plain and contextualized, so the
 * same query can be run against both and the difference read off directly.
 *
 * It depends on one port you implement for your setup, `ChunkStore`, plus the
 * generic effect-uai capability tags: `libsql.ts` is this demo's implementation
 * and `app.ts` picks the chunker and providers.
 */
import { Array as Arr, Context, Effect, pipe, Ref, Result, Schedule } from "effect"
import { chunk as splitDocument } from "@effect-uai/core/Chunker"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Items from "@effect-uai/core/Items"
import { turn } from "@effect-uai/core/LanguageModel"
import { rerank } from "@effect-uai/core/Reranker"
import * as Retry from "@effect-uai/core/Retry"
import * as Turn from "@effect-uai/core/Turn"
import * as Rank from "@effect-uai/retrieval/Rank"

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/** Which of the two indexes a query runs against. */
export type Variant = "plain" | "contextual"

/** A stored chunk, addressed by the id the store gave it. */
export type Passage = {
  readonly id: number
  readonly text: string
}

/** A passage with the score of whichever leg returned it. Higher is better. */
export type Scored = Passage & {
  readonly score: number
}

export type StoredChunk = {
  readonly text: string
  /** The situating blurb. Prepended to `text` for the contextual index. */
  readonly context: string
  readonly embedding: Float32Array
  readonly contextualEmbedding: Float32Array
}

/**
 * Two indexes over one set of chunks. `dense` and `lexical` take the variant,
 * so the retrieval code below is written once and runs against either.
 */
export type ChunkStoreService = {
  readonly count: Effect.Effect<number>
  readonly add: (rows: ReadonlyArray<StoredChunk>) => Effect.Effect<void>
  readonly dense: (
    variant: Variant,
    query: Float32Array,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Scored>>
  readonly lexical: (
    variant: Variant,
    query: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Scored>>
}

export class ChunkStore extends Context.Service<ChunkStore, ChunkStoreService>()(
  "contextual-retrieval/ChunkStore",
) {}

// ---------------------------------------------------------------------------
// Contextualization
// ---------------------------------------------------------------------------

/**
 * Anthropic's published prompt. This is the domain-tuning surface: for
 * contracts or support tickets, say what matters there (parties and dates,
 * product and version) instead.
 */
export const SITUATE_PROMPT = [
  "Here is the chunk we want to situate within the whole document:",
  "<chunk>",
  "{chunk}",
  "</chunk>",
  "",
  "Please give a short succinct context to situate this chunk within the overall",
  "document for the purposes of improving search retrieval of the chunk.",
  "Answer only with the succinct context and nothing else.",
].join("\n")

/** Tokens billed across the indexing pass, so the cache can be seen working. */
export type Cost = {
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

const noCost: Cost = {
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
}

const addCost = (a: Cost, b: Cost): Cost => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  outputTokens: a.outputTokens + b.outputTokens,
})

const costOf = (usage: Items.Usage): Cost => ({
  inputTokens: usage.input_tokens ?? 0,
  cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
  cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
  outputTokens: usage.output_tokens ?? 0,
})

/**
 * One blurb for one chunk. The document rides in the system message so it is
 * byte-identical on every call: that prefix is what prompt caching reuses, and
 * changing so much as a space in it costs a full re-read.
 */
export const contextualize = (document: string, chunkText: string, model: string) =>
  turn({
    model,
    history: [
      Items.systemText(`<document>\n${document}\n</document>`),
      Items.userText(SITUATE_PROMPT.replace("{chunk}", chunkText)),
    ],
    maxOutputTokens: 200,
  }).pipe(
    Effect.map((result) => ({
      context: Turn.assistantTexts(result).join("").trim(),
      cost: costOf(result.usage),
    })),
  )

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export type IngestOptions = {
  readonly embedModel: string
  readonly contextModel: string
  /** Chunks per embedding call. Default 64. */
  readonly batchSize?: number
  /** Concurrent contextualization calls once the cache is warm. Default 4. */
  readonly concurrency?: number
  readonly dimensions?: number
  /** Called once chunking is done, before the LLM pass starts. */
  readonly onChunked?: (total: number) => Effect.Effect<void>
  /** Called after each situating blurb. The longest phase, so report it. */
  readonly onContext?: (done: number, total: number) => Effect.Effect<void>
  /** Called after each batch is embedded and stored. */
  readonly onProgress?: (done: number, total: number) => Effect.Effect<void>
}

export type IngestResult = {
  readonly chunks: number
  readonly ingested: boolean
  readonly cost: Cost
}

/** Prepended form. Keep it identical here and in the store. */
export const contextualText = (context: string, text: string): string =>
  context === "" ? text : `${context}\n\n${text}`

/**
 * Exponential backoff on the retryable subset of `AiError` (rate limits,
 * timeouts, transient unavailability). Everything else fails immediately.
 */
const backoff = Retry.effect(
  Schedule.exponential("1 second", 2).pipe(Schedule.upTo({ times: 5 }), Schedule.jittered),
)

/**
 * Chunk, contextualize, embed both variants, store. Resumable: chunking is
 * deterministic, so a store holding fewer rows than the document has chunks is
 * a run that died partway, and only the missing tail is redone. A store with
 * every chunk is left alone, so re-running never repays the LLM pass.
 */
export const ingest = (document: string, options: IngestOptions) =>
  Effect.gen(function* () {
    const store = yield* ChunkStore
    const stored = yield* store.count

    const all = yield* splitDocument(document)
    if (stored >= all.length) return { chunks: stored, ingested: false, cost: noCost }

    const chunks = Arr.drop(all, stored)
    yield* options.onChunked?.(all.length) ?? Effect.void

    const done = yield* Ref.make(stored)
    const situate = (text: string) =>
      contextualize(document, text, options.contextModel).pipe(
        Effect.tap(() =>
          Ref.updateAndGet(done, (n) => n + 1).pipe(
            Effect.flatMap((n) => options.onContext?.(n, all.length) ?? Effect.void),
          ),
        ),
      )

    // The first call alone: it writes the cache the rest read. Firing the
    // whole batch at once would have every request miss a cache nobody wrote.
    const first = yield* Effect.forEach(Arr.take(chunks, 1), (c) => situate(c.text))
    const rest = yield* Effect.forEach(Arr.drop(chunks, 1), (c) => situate(c.text), {
      concurrency: options.concurrency ?? 4,
    })
    const contexts = [...first, ...rest]
    const cost = Arr.reduce(contexts, noCost, (total, c) => addCost(total, c.cost))

    const rows = Arr.map(chunks, (c, i) => ({
      text: c.text,
      context: contexts[i]?.context ?? "",
    }))
    const batchSize = options.batchSize ?? 64

    yield* Effect.forEach(
      Arr.chunksOf(rows, batchSize),
      (batch, i) =>
        Effect.all(
          [
            embedMany({
              model: options.embedModel,
              inputs: Arr.map(batch, (r) => r.text),
              task: "document",
              ...(options.dimensions !== undefined && {
                dimensions: options.dimensions,
              }),
            }),
            embedMany({
              model: options.embedModel,
              inputs: Arr.map(batch, (r) => contextualText(r.context, r.text)),
              task: "document",
              ...(options.dimensions !== undefined && {
                dimensions: options.dimensions,
              }),
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          // Embedding a whole corpus reliably outruns a provider's rate limit.
          // Back off and resume rather than losing the LLM pass above it.
          backoff,
          Effect.flatMap(([plain, contextual]) =>
            store.add(
              Arr.map(batch, (row, j) => ({
                ...row,
                embedding: plain.embeddings[j]!.vector,
                contextualEmbedding: contextual.embeddings[j]!.vector,
              })),
            ),
          ),
          Effect.andThen(
            options.onProgress?.(Math.min(stored + (i + 1) * batchSize, all.length), all.length) ??
              Effect.void,
          ),
        ),
      { discard: true },
    )

    return { chunks: all.length, ingested: true, cost }
  })

// ---------------------------------------------------------------------------
// Retrieval, run identically against either index
// ---------------------------------------------------------------------------

export type SearchOptions = {
  readonly embedModel: string
  readonly rerankModel: string
  readonly dimensions?: number
  /** Candidates per retrieval leg. Default 100. */
  readonly perLeg?: number
  /** Fused candidates handed to the reranker. Default 20. */
  readonly rerankDepth?: number
  /** Passages kept for the answer. Default 5. */
  readonly keep?: number
}

export type Stages = {
  readonly variant: Variant
  readonly dense: ReadonlyArray<Scored>
  readonly lexical: ReadonlyArray<Scored>
  readonly fused: ReadonlyArray<Rank.Fused<number>>
  readonly reranked: ReadonlyArray<Scored>
}

export const search = (query: string, variant: Variant, options: SearchOptions) =>
  Effect.gen(function* () {
    const store = yield* ChunkStore
    const perLeg = options.perLeg ?? 100

    const queryVector = yield* embed({
      model: options.embedModel,
      input: query,
      task: "query",
      ...(options.dimensions !== undefined && {
        dimensions: options.dimensions,
      }),
    }).pipe(
      backoff,
      Effect.map((r) => r.embedding.vector),
    )

    const dense = yield* store.dense(variant, queryVector, perLeg)
    const lexical = yield* store.lexical(variant, query, perLeg)

    const fused = Rank.rrf([Arr.map(dense, (d) => d.id), Arr.map(lexical, (l) => l.id)])

    // Every fused id came from one of the legs, so their rows carry the text.
    const texts = new Map(Arr.map([...dense, ...lexical], (c): [number, string] => [c.id, c.text]))
    const candidates = Arr.filterMap(
      Arr.take(fused, options.rerankDepth ?? 20),
      (f): Result.Result<Passage, void> => {
        const text = texts.get(f.value)
        return text === undefined ? Result.failVoid : Result.succeed({ id: f.value, text })
      },
    )

    const { results } = yield* rerank({
      model: options.rerankModel,
      query,
      documents: Arr.map(candidates, (c) => c.text),
      topN: options.keep ?? 5,
    }).pipe(backoff)

    // `results[].index` addresses the list we sent, not the store.
    const reranked = Arr.map(results, (r): Scored => ({ ...candidates[r.index]!, score: r.score }))

    return { variant, dense, lexical, fused, reranked }
  })

/** Both indexes, same query, same depths. Contextualization is the only variable. */
export const compare = (query: string, options: SearchOptions) =>
  Effect.map(
    Effect.all([search(query, "plain", options), search(query, "contextual", options)], {
      concurrency: 2,
    }),
    ([plain, contextual]) => ({ plain, contextual }),
  )

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

const ANSWER_PROMPT = [
  "Answer the question using only the passages provided.",
  "Cite the passage ids you used, e.g. (id 42).",
  "If the passages do not answer the question, say so plainly.",
].join("\n")

/** One grounded turn over the passages a variant retrieved. */
export const answer = (question: string, passages: ReadonlyArray<Passage>, model: string) =>
  pipe(
    Arr.map(passages, (p) => `[id ${p.id}]\n${p.text}`).join("\n\n"),
    (context) =>
      turn({
        model,
        history: [
          Items.systemText(ANSWER_PROMPT),
          Items.userText(`Passages:\n\n${context}\n\nQuestion: ${question}`),
        ],
      }),
    Effect.map((result) => Turn.assistantTexts(result).join("").trim()),
  )
