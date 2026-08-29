# Research plan: RAG recipes (v0.13 items 2 and 2b)

How to research the plain RAG recipe (`recipes/`) and the hybrid RAG
flagship (`recipes-extras/hybrid-rag/`) before building them. Findings
land in `plans/research/rag-recipe.md`.

## What the v0-13 plan already fixes (design constraints, not questions)

- Item 2: in-memory corpus, `embedMany` + `Vector.cosine` +
  `Reranker.rerank` + `loop`, full current recipe shape, CI-tested.
- Item 2b: libsql single file, FTS5 `bm25()` lexical leg,
  `vector_top_k` dense leg, RRF in core (~15 lines, next to
  `Vector.ts`), `Reranker` on the fused top-N, Effect SQL pattern via
  `@effect/sql-libsql`, lives in extras.

## Questions

### Q1. libsql technical verification (the recipe's load-bearing claims)

Everything 2b promises rests on the local-file mode actually doing
what the marketing pages say. Verify from primary docs and the
`@libsql/client` / libsql repos:

- Does native vector search (`F32_BLOB`, `libsql_vector_idx`,
  `vector_top_k`, `vector_distance_cos`) work in **embedded/local
  file mode** via `@libsql/client` (`file:...` URL), or only against
  a sqld/Turso server? Which client package and version.
- Is FTS5 compiled into the embedded libsql build, with the `bm25()`
  auxiliary function? (Distinguish classic libsql from the new
  Turso-rewrite database with Tantivy FTS; the recipe targets
  whichever `@effect/sql-libsql` drives.)
- What exactly does `@effect/sql-libsql@4.0.0-rc.111` wrap (which
  underlying client, config surface, layer shape), and does it run on
  Bun and Deno or Node only? This decides which `run-*.ts` runners
  the recipe ships.
- Fallback option if any of the above fails: `@effect/sql-sqlite-node`
  (better-sqlite3) with FTS5 plus manual cosine over stored vectors,
  or `sqlite-vec`. Establish the fallback's viability so the recipe
  design survives a dead end.

### Q2. Hybrid retrieval parameters (state of the art, 2025-2026)

The recipe teaches numbers as much as shape; get them from current
sources, not 2023 tutorials:

- RRF: is k=60 still the standard constant; weighted variants worth
  showing? What candidate depths do production pipelines use per leg
  (top-50? top-100?) and after fusion (rerank input size)?
- Chunking defaults worth hardcoding in a demo: chunk size, overlap,
  sentence vs token boundaries. What current engineering writeups
  actually recommend.
- Embedding leg: query vs document task asymmetry (we have `task` on
  `CommonEmbedRequest`; the recipe should demonstrate it correctly
  with Jina).
- Where hybrid beats dense-only, briefly, for the README's "why"
  section (user-POV: the problem, not the wire).

### Q3. Showcase landscape (what the recipe competes with)

Quick survey of what comparable libraries ship as their RAG example
(Vercel AI SDK RAG guide, LangChain/LlamaIndex quickstarts, Mastra
RAG, Effect ecosystem examples if any). Not to copy: to know what
readers will compare against and what gap a typed, single-file,
hybrid + RRF + rerank recipe fills. Output: two sentences of
positioning for the README.

### Q4. In-repo fit (no web needed)

- Recipe conventions to reuse: `_shared` helpers (argv, rendering),
  the `recipe.ts` / `app.ts` / runner split, how extras
  (`sandbox-code-interpreter`) structure install and README given the
  standalone `pnpm-workspace.yaml` exclusion.
- What the corpus is: small bundled text (a dozen documents in a
  `corpus.ts` or fetched md files), so the demo runs with one API key
  (Jina covers both embed and rerank) and no other accounts.
- Test strategy: item 2 mocks (`MockProvider`-style) for embeddings
  and rerank; whether 2b can be CI-tested with a temp-file DB (libsql
  embedded needs no server, so probably yes; verify install weight).
- Where RRF lands in core: `math/Rank.ts` vs folding into
  `Vector.ts`; signature sketch against real call sites from both
  recipes.

## Method

1. In-repo sweep first (Q4).
2. Q1 via primary docs and repo issues; this is verification, so
   prefer README/docs of `@libsql/client`, libsql repo, Effect sql
   driver source on npm. Flag anything only marketing pages claim.
3. Q2/Q3 web research, 2025-2026 sources.
4. Findings doc, then fold consequences back into
   [plans/v0-13.md](../v0-13.md) items 2/2b.

## Out of scope

- Reranking wire research (done: [reranking.md](./reranking.md)).
- Vector DB servers (pgvector, Qdrant); the point is on-file.
- Implementing anything.
