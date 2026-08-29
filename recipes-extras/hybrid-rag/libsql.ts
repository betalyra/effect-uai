/**
 * One implementation of the `ChunkStore` port, over a single libsql file:
 * an `F32_BLOB` column with a vector index for the dense leg, and an FTS5
 * table with `bm25()` for the lexical leg. No server, no extension loading.
 *
 * Single writer only. Two processes ingesting the same file concurrently
 * corrupt the vector index shadow table.
 */
import { Array as Arr, Effect, Layer, pipe } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { LibsqlClient } from "@effect/sql-libsql"
import { ChunkStore, type ChunkStoreService, type Scored } from "./recipe.js"

const VECTOR_INDEX = "chunks_embedding_idx"

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
           embedding F32_BLOB(${dimensions}) NOT NULL
         )`,
      )
      .pipe(
        Effect.andThen(
          sql.unsafe(
            `CREATE INDEX IF NOT EXISTS ${VECTOR_INDEX} ON chunks (libsql_vector_idx(embedding))`,
          ),
        ),
        Effect.andThen(
          sql.unsafe(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text)`),
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
                      .unsafe(`INSERT INTO chunks (text, embedding) VALUES (?, vector32(?))`, [
                        row.text,
                        vectorLiteral(row.embedding),
                      ])
                      .pipe(
                        Effect.andThen(
                          sql.unsafe(
                            `INSERT INTO chunks_fts (rowid, text) VALUES (last_insert_rowid(), ?)`,
                            [row.text],
                          ),
                        ),
                      ),
                  { discard: true },
                ),
              ),
            ),
            Effect.orDie,
          ),

    // `vector_top_k` returns rowids, so the join is on `rowid`.
    dense: (query, limit) => {
      const literal = vectorLiteral(query)
      return sql
        .unsafe<Scored>(
          `SELECT c.rowid AS id, c.text AS text,
                  1 - vector_distance_cos(c.embedding, vector32(?)) AS score
             FROM vector_top_k('${VECTOR_INDEX}', vector32(?), ?) AS t
             JOIN chunks c ON c.rowid = t.id
            ORDER BY score DESC`,
          [literal, literal, limit],
        )
        .pipe(Effect.orDie)
    },

    // FTS5 `bm25()` is more negative for a better match, so negate for "higher is better".
    lexical: (query, limit) => {
      const terms = ftsQuery(query)
      return terms === ""
        ? Effect.succeed([])
        : sql
            .unsafe<Scored>(
              `SELECT rowid AS id, text, -bm25(chunks_fts) AS score
                 FROM chunks_fts
                WHERE chunks_fts MATCH ?
                ORDER BY bm25(chunks_fts)
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
