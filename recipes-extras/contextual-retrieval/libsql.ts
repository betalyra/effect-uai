/**
 * One implementation of the `ChunkStore` port over a single libsql file,
 * holding both indexes: two `F32_BLOB` columns with their own vector indexes,
 * and two FTS5 tables. One row per chunk, so ids line up across variants and
 * a rank movement means what it looks like.
 *
 * Single writer only. Two processes ingesting the same file corrupt the vector
 * index shadow table.
 */
import { Array as Arr, Effect, Layer, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { LibsqlClient } from "@effect/sql-libsql"
import {
  ChunkStore,
  type ChunkStoreService,
  contextualText,
  type Scored,
  type Variant,
} from "./recipe.js"

/** Per-variant column, index, and full-text table. */
const schemaOf = (variant: Variant) =>
  variant === "plain"
    ? { column: "embedding", index: "chunks_embedding_idx", fts: "chunks_fts" }
    : { column: "ctx_embedding", index: "chunks_ctx_embedding_idx", fts: "chunks_ctx_fts" }

/** libsql parses a vector from a JSON array literal. */
const vectorLiteral = (v: Float32Array): string => `[${Array.from(v).join(",")}]`

/**
 * FTS5 parses its own query syntax, so a natural-language question has to be
 * reduced to quoted terms or a stray apostrophe is a syntax error.
 */
export const ftsQuery = (question: string): string =>
  pipe(
    Arr.filter(question.toLowerCase().split(/[^\p{L}\p{N}]+/u), (t) => t.length > 2),
    Arr.map((t) => `"${t}"`),
    Arr.join(" OR "),
  )

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Dimension comes from the first batch written, not a per-model constant.
  const ensureSchema = (dimensions: number) =>
    sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS chunks (
           id INTEGER PRIMARY KEY,
           text TEXT NOT NULL,
           context TEXT NOT NULL,
           embedding F32_BLOB(${dimensions}) NOT NULL,
           ctx_embedding F32_BLOB(${dimensions}) NOT NULL
         )`,
      )
      .pipe(
        Effect.andThen(
          Effect.forEach(
            ["plain", "contextual"] as const,
            (variant) => {
              const { column, fts, index } = schemaOf(variant)
              return sql
                .unsafe(
                  `CREATE INDEX IF NOT EXISTS ${index} ON chunks (libsql_vector_idx(${column}))`,
                )
                .pipe(
                  Effect.andThen(
                    sql.unsafe(`CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(text)`),
                  ),
                )
            },
            { discard: true },
          ),
        ),
      )

  return {
    // A fresh file has no tables yet, which reads as "nothing ingested".
    count: sql.unsafe<{ readonly n: number }>(`SELECT COUNT(*) AS n FROM chunks`).pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.orElseSucceed(() => 0),
    ),

    add: (rows) =>
      rows.length === 0
        ? Effect.void
        : ensureSchema(rows[0]!.embedding.length).pipe(
            Effect.andThen(
              // Sequential and in one transaction: the vector index rejects
              // concurrent writers, and per-row commits are far slower.
              sql.withTransaction(
                Effect.forEach(
                  rows,
                  (row) =>
                    sql
                      .unsafe(
                        `INSERT INTO chunks (text, context, embedding, ctx_embedding)
                         VALUES (?, ?, vector32(?), vector32(?))`,
                        [
                          row.text,
                          row.context,
                          vectorLiteral(row.embedding),
                          vectorLiteral(row.contextualEmbedding),
                        ],
                      )
                      .pipe(
                        Effect.andThen(
                          sql.unsafe(
                            `INSERT INTO chunks_fts (rowid, text) VALUES (last_insert_rowid(), ?)`,
                            [row.text],
                          ),
                        ),
                        // The contextual lexical leg indexes the blurb too:
                        // that is what lets a keyword hit the chunk lacked land.
                        Effect.andThen(
                          sql.unsafe(
                            `INSERT INTO chunks_ctx_fts (rowid, text) VALUES (last_insert_rowid(), ?)`,
                            [contextualText(row.context, row.text)],
                          ),
                        ),
                      ),
                  { discard: true },
                ),
              ),
            ),
            Effect.orDie,
          ),

    // `vector_top_k` returns rowids, so the join is on `rowid`. Text comes from
    // `chunks`, never the FTS copy, so both variants quote the same passage.
    dense: (variant, query, limit) => {
      const { column, index } = schemaOf(variant)
      const literal = vectorLiteral(query)
      return sql
        .unsafe<Scored>(
          `SELECT c.rowid AS id, c.text AS text,
                  1 - vector_distance_cos(c.${column}, vector32(?)) AS score
             FROM vector_top_k('${index}', vector32(?), ?) AS t
             JOIN chunks c ON c.rowid = t.id
            ORDER BY score DESC`,
          [literal, literal, limit],
        )
        .pipe(Effect.orDie)
    },

    // FTS5 `bm25()` is more negative for a better match, so negate for "higher is better".
    lexical: (variant, query, limit) => {
      const { fts } = schemaOf(variant)
      const terms = ftsQuery(query)
      return terms === ""
        ? Effect.succeed([])
        : sql
            .unsafe<Scored>(
              `SELECT f.rowid AS id, c.text AS text, -bm25(${fts}) AS score
                 FROM ${fts} f
                 JOIN chunks c ON c.rowid = f.rowid
                WHERE ${fts} MATCH ?
                ORDER BY bm25(${fts})
                LIMIT ?`,
              [terms, limit],
            )
            .pipe(Effect.orDie)
    },
  } satisfies ChunkStoreService
})

/** `ChunkStore` over a local libsql file, e.g. `file:rag.db`. */
export const layer = (url: string): Layer.Layer<ChunkStore> =>
  Layer.effect(ChunkStore, make).pipe(Layer.provide(LibsqlClient.layer({ url })))
