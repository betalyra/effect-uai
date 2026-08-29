# Plan: `contextual-retrieval` recipe (v0.14 candidate)

Anthropic-style contextual retrieval as a recipe in
`recipes-extras/`, built on the hybrid-rag recipe's corpus and
database. Not part of v0.13; requires `@effect-uai/retrieval`
([plans/chunking.md](./chunking.md)) to have shipped.

## What it is

At indexing time, an LLM reads the whole document plus each chunk and
writes a 50-100 token blurb situating the chunk; the blurb is
prepended before BOTH the embedding and the BM25 indexing. Source:
Anthropic engineering post (Sept 2024). Reported: 35% fewer top-20
retrieval failures from contextual embeddings alone, 49% with
contextual BM25, 67% with reranking; independent 2025-2026
reproductions are more modest (5-15% retrieval precision). Cost is
one LLM call per chunk at indexing time, ~$1.02 per million document
tokens with prompt caching; it amortizes only on corpora that do not
churn. Still the reference technique for the retrieval quality tier;
nothing has superseded it.

## Separate recipe, not a merge with hybrid-rag (decided)

Keep the two recipes independent:

- **One lesson per recipe.** hybrid-rag teaches hybrid + fusion +
  rerank with zero infrastructure and one API key. Contextual
  retrieval teaches an indexing-time LLM pass and its measured
  uplift. Merging produces one large recipe with two lessons, two API
  keys, and modes, which is exactly the complex-setup shape the
  recipe philosophy forbids.
- **Cost stays opt-in.** hybrid-rag must remain runnable for cents.
  A merged recipe either always pays the per-chunk LLM cost or grows
  a `--contextual` flag, and recipes should not have modes.
- **Separation IS the showcase.** The contextual recipe's whole
  story is a before/after against the plain index; that comparison
  needs both pipelines in one program anyway (two indexes, same
  queries), not one recipe with a toggle.
- Copy, don't share: extras have no `_shared`, and recipes are
  copy-paste artifacts. Duplicating the ingest scaffolding from
  hybrid-rag is idiomatic; both import the real logic
  (`Chunking`, `Rank.rrf`, `BM25` where applicable) from
  `@effect-uai/retrieval`.

## Recipe design

`recipes-extras/contextual-retrieval/`, standalone package following
the hybrid-rag conventions (private, `link:` deps incl.
`@effect-uai/retrieval` and `@effect-uai/anthropic`, own workspace
file, `run-node.ts` / `run-bun.ts` / `run-deno.ts`).

**Corpus**: the same Gutenberg book as hybrid-rag (same fetch, strip,
cache logic), so readers who ran hybrid-rag see the delta on familiar
ground.

**Ingest** (idempotent, the expensive step, one libsql file):

1. Chunk with `Chunking.sentences` (~512 target), identical
   parameters to hybrid-rag for comparability.
2. For each chunk, ask the LLM for the situating blurb with the
   Anthropic-published prompt ("short succinct context to situate
   this chunk within the overall document for the purposes of
   improving search retrieval"). The full document rides in the
   request with prompt caching ON: the anthropic package already
   supports it (config-level `cacheControl`,
   `packages/providers/anthropic/src/Anthropic.ts`, off by default);
   the recipe turns it on and prints the cache-read savings from
   usage, which is itself a showcase of the feature.
3. Store BOTH variants per chunk: plain text + contextualized text
   (blurb + chunk). Two FTS5 tables and two embedding columns (or
   two chunk tables); embed both with `task: "document"`.

**Query** (cheap, repeatable): run the identical hybrid pipeline
twice per question, once against the plain index, once against the
contextualized one: dense `vector_top_k` + FTS5 `bm25()` (~100 per
leg), `Rank.rrf`, `Reranker.rerank` top ~20, answer from top ~5.
Depths match hybrid-rag, NOT Anthropic's top-150/top-20, so the only
variable is contextualization.

**Output = the showcase**: for each demo question, side-by-side
retrieved-chunk tables (plain vs contextual) with rank movements
highlighted, at least one built-in question where the plain index
misses the answering chunk and the contextual one finds it
(pronoun-heavy or back-reference passages are where the technique
wins; pick questions while developing, verified live), then both
grounded answers. Also print the one-time indexing cost (tokens, and
cache-read share).

**Keys**: `JINA_API_KEY` (embed + rerank) and `ANTHROPIC_API_KEY`
(contextualization). Two keys is acceptable for an extras recipe;
the LLM is deliberately not made pluggable in v1 (prompt caching
behavior is the point, and Anthropic is where our caching support
lives today).

**README**: user POV. The problem: chunks lose their surroundings
("the company" - which company?), so retrieval misses chunks whose
meaning lives in context. The economics: pay once at indexing, only
worth it for corpora that do not churn; honest numbers (Anthropic's
and the more modest reproductions). Position against late chunking in
one line (cheaper, embedding-leg-only, model-constrained).

## Prerequisites and timing

- `@effect-uai/retrieval` shipped (Chunking, Rank; BM25 unused here
  since libsql FTS5 does lexical).
- hybrid-rag recipe merged and stable (this copies its scaffolding).
- v0.14 item. Not in v0.13: the plate is full and the dependency
  chain above is not.

## Out of scope

- Any package API for contextualization: the technique is one prompt
  plus a loop, and the prompt is the domain-tuning surface. A helper
  would freeze exactly what users should edit.
- Provider-pluggable contextualizer, portable prompt-caching marker
  (separate roadmap item), corpus-churn/incremental re-indexing,
  late-chunking comparison implementation.
