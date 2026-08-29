# Research: RAG recipes (v0.13 items 2 and 2b)

Findings for the questions in
[rag-recipe-plan.md](./rag-recipe-plan.md). Q1 was verified
empirically (test scripts run on this machine, Aug 2026), Q2/Q3 from
2025-2026 web sources, Q4 in-repo. UNVERIFIED flags carried through.

## Verdict up front

**2b is fully de-risked.** Every load-bearing claim about libsql holds,
verified by actually running it: native vector search and FTS5 with
`bm25()` both work in one embedded `file:` database, in-process, no
server, on Node 24, Bun 1.3, and Deno 2.9. `@effect/sql-libsql` at
exactly our pinned rc.111 wraps `@libsql/client@^0.17.4` and exposes
`LibsqlClient.layer({ url: "file:demo.db" })`. No fallback needed.

**The positioning is stronger than assumed**: no mainstream TS
framework (Vercel AI SDK, LangChain JS, LlamaIndex.TS, Mastra) ships a
canonical RAG example with true lexical+dense hybrid and rank fusion.
Ours would be the first that is simultaneously zero-infra (one local
file) and architecturally what production teams deploy in 2026.

**One design decision surfaced**: item 2 (plain RAG recipe) overlaps
[recipes/basic-embedding/](../../recipes/basic-embedding/), which is
already embed + cosine ranking in one file. See Q4.

## Q1. libsql technical verification: all VERIFIED

Empirical, `@libsql/client@0.17.4` (native binding `libsql@0.5.29`),
`createClient({ url: "file:local.db" })`, in-process:

- **Vector search**: `F32_BLOB(n)` columns, `libsql_vector_idx` index,
  `vector32()` inserts, `vector_top_k` KNN (join on `docs.rowid =
t.id`), `vector_distance_cos`. All work locally; the vector code
  lives in libsql core, not the server.
- **FTS5**: `CREATE VIRTUAL TABLE ... USING fts5`, `MATCH`, and the
  `bm25()` auxiliary function all work; the embedded engine reports
  `ENABLE_FTS5` (SQLite 3.45.1). Local file mode still runs classic
  libsql (the SQLite C fork), not the beta Rust rewrite
  (`@tursodatabase/database`), which is a separate package family.
- **`@effect/sql-libsql@4.0.0-rc.111`** (tarball inspected): wraps
  `@libsql/client@^0.17.4`, peer `effect@^4.0.0-rc.111` (our exact
  pin). Surface: `LibsqlClient.layer(config)` returning
  `Layer<LibsqlClient | SqlClient>`, `layerConfig`, `make`; config
  takes `url` (`file:` documented as supported), `authToken?`, etc.,
  or a caller-owned `liveClient`. `LibsqlMigrator` ships too.
- **Runtimes**: the identical vector+FTS5 script passed on Node
  24.16.0, Bun 1.3.14, and Deno 2.9.1 (Deno needs
  `--allow-ffi --allow-read --allow-write --allow-env`). Historical
  Bun napi issues are resolved. The recipe ships all three runners.

Caveats to encode in the recipe:

- **Single-writer.** Two processes writing concurrently produced
  `vector index(insert): failed to insert shadow row`. Fine for the
  recipe; note it in the README.
- The _web_ variant of `@libsql/client` rejects `file:` URLs; only
  the native path does local files.
- Avoid `sqlite-vec` (recurring ABI/extension-loading failures across
  runtimes in 2026) and the Turso rewrite (beta, different API).

## Q2. Hybrid retrieval parameters, 2025-2026

- **RRF**: `score(d) = Σ 1/(k + rank_d)` with **k=60** is what a 2026
  reader expects (Elasticsearch default; Supabase's pgvector guide
  uses 50; Qdrant is the outlier with a zero-based-rank k=2 default).
  **Weighted RRF is mainstream** (Elasticsearch retriever `weight`,
  Qdrant v1.17 per-prefetch weights, Supabase per-leg weights
  defaulting to 1). Circulating weight guidance: identifier-heavy
  corpora BM25 0.7 / dense 0.3; paraphrase-heavy 0.3 / 0.7; mixed
  0.5 / 0.5.
- **Candidate depths**, the citable 2026 default:
  **~100 per leg → RRF → rerank the fused top 20-30 → top 5 to the
  LLM.** Cross-encoder rerank adds 5-15 NDCG@10 points typically for
  under 200ms.
- **Chunking**: recursive/sentence-boundary splitting at **~400-512
  tokens with 10-20% (50-100 token) overlap** is the 2026
  benchmark-validated baseline; semantic/LLM chunking is "only if
  metrics prove you need it".
- **Task asymmetry confirmed universal**: retrieval-tuned models still
  want distinct query vs document treatment (Gemini `RETRIEVAL_QUERY`
  / `RETRIEVAL_DOCUMENT`, Cohere `search_query` / `search_document`,
  Voyage, Nomic prefixes). The recipes must pass `task: "query"` /
  `task: "document"` and say why.
- **Hybrid beats dense-only** with dated evidence: WANDS e-commerce
  2025 (tuned hybrid NDCG 0.7497 vs 0.6953 vector-only), Strich et
  al. 2026 financial docs (hybrid+rerank Recall@5 0.816 vs 0.587
  dense-only), TREC TOT 2025 (fusion beat the best single retriever
  on every dataset). Pattern: hybrid wins biggest on IDs, exact
  names, jargon, code symbols; ties dense on paraphrase-heavy
  questions. That is the README's "why" in one sentence.

## Q3. Landscape and positioning

- **Vercel AI SDK** RAG guide: Next.js + Drizzle + pgvector,
  dense-only, retrieval as a tool. No BM25, no fusion, no reranker.
- **LangChain JS** quickstart: in-memory vector store, dense-only;
  hybrid pieces exist as separate integrations, assembly left to the
  reader.
- **LlamaIndex.TS**: in-memory index persisted to JSON, dense-only in
  the TS getting-started path.
- **Mastra**: the most complete (chunking, many stores, a `rerank()`
  stage via Cohere), but its "hybrid" is vector + metadata filtering,
  not lexical BM25, and there is no fusion stage. Cloud-oriented.

Positioning (two sentences, for the README): every TS framework's
canonical RAG example stops at dense-only retrieval or bolts a rerank
API onto a cloud vector database. This recipe runs the architecture
production teams actually deploy (lexical + dense legs, weighted RRF,
cross-encoder rerank, typed agent loop) against one local file, with
zero infrastructure.

## Q4. In-repo fit

- **Item 2 overlaps `basic-embedding`.**
  [recipes/basic-embedding/index.ts](../../recipes/basic-embedding/index.ts)
  is already "embed a query and documents, rank by cosine" and its
  header even says "no vector DB, no chunker, no reranker".
  Recommendation: ship item 2 as a **new** recipe (working name
  `retrieve-and-rerank`) whose story is the delta: candidates by
  cosine, precision by `Reranker`, answer by `loop`, with Jina
  covering embed + rerank on one key. Leave `basic-embedding` as the
  embeddings-section teaching sample (optionally upgrade it to the
  full recipe shape later; it currently has no runner and no test).
- **Extras convention** (from `sandbox-code-interpreter`): standalone
  private package (`version: 0.0.0`), `link:../../packages/...` deps,
  own `pnpm-workspace.yaml` + lockfile, `tsx run.ts`, README with
  docs frontmatter (`title`, `description`, `source`, `icon`). The
  hybrid recipe adds `@effect/sql-libsql` + `@libsql/client` there
  without touching the root workspace. Extras are outside root CI;
  tests run manually like the integration tests, which the verified
  embedded mode makes trivial (temp-file DB, no server).
- **RRF in core**: `packages/core/src/math/Rank.ts`, exported as
  `./Rank` (keeping `Vector.ts` about vectors). Signature driven by
  both call sites, weighted per current practice:

  ```ts
  export const rrf = <A>(
    rankings: ReadonlyArray<ReadonlyArray<A>>,
    options?: { readonly k?: number; readonly weights?: ReadonlyArray<number> },
  ): Array<{ readonly value: A; readonly score: number }>
  // k defaults to 60; weights default to 1 per ranking; result sorted
  // descending. A compared by reference/primitive equality; recipes
  // rank document ids.
  ```

- **One API key** runs both recipes end to end: Jina embeddings
  (`jina-embeddings-v4` or v3 with `task`) + Jina rerank
  (`jina-reranker-v3.5`). The corpus is a small bundled `corpus.ts`;
  no accounts beyond `JINA_API_KEY`.

## Consequences for plans/v0-13.md

- Item 2: rename working title to `retrieve-and-rerank`; position
  against `basic-embedding` explicitly.
- Item 2b: stack confirmed (`@effect/sql-libsql` +
  `LibsqlClient.layer({ url: "file:..." })`); all three runners; add
  the single-writer caveat; bake in the citable defaults (k=60
  weighted RRF, ~100/leg, rerank top 20, answer from top 5, 512-token
  chunks with 10-20% overlap).
- RRF lands as `core/src/math/Rank.ts` with the weighted signature
  above (a small scope increase over "~15 lines" but still S).
