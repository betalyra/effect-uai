---
title: Hybrid RAG
description: Search that catches exact names and paraphrases both, handed to an agent as a tool it can call again when the first try misses. Runs on one local file, no database server.
source: recipes-extras/hybrid-rag
icon: PiDatabase
---

Embedding search and keyword search fail in opposite directions.

Ask a vector index for "the speckled band" and it returns passages about
snakes, bell-ropes, and Indian animals: all related, none of them the phrase.
Ask BM25 "why did the sister die" and it hunts for those words, which the book
never uses. One is good at meaning and bad at exact strings. The other is the
reverse.

So run both and merge the results. This recipe does that, reranks what
survives, and gives the whole thing to an agent as **a tool it calls** instead
of context stuffed into a prompt. The model searches, reads what came back,
rephrases and searches again if it needs to, then answers.

## The stack

1. **Two legs, independently.** Vector KNN over an `F32_BLOB` column, and FTS5
   scored by `bm25()`. About 100 candidates each.
2. **Rank fusion merges them by position**, `Rank.rrf` from core. Positions
   rather than scores, because BM25 and cosine are incomparable scales.
3. **A reranker re-scores the fused top 20** and keeps 5. Fusion gets you
   recall; this is the step that cares which candidate answers the question.
4. **An ordinary agent loop** decides when to search and what to search for.

All of it against one file on disk: no server, no vector database, no extension
loading.

## Run it

```sh
pnpm -C recipes-extras/hybrid-rag install

JINA_API_KEY=jina_... LLM_API_KEY=sk-... \
  ./recipes-extras/hybrid-rag/node_modules/.bin/tsx \
  recipes-extras/hybrid-rag/run-node.ts "why does the speckled band kill?"
```

The first run downloads a public-domain book, chunks it, embeds it, and writes
`rag.db` next to the recipe. Later runs reuse both, so only the first costs
embedding tokens. One `JINA_API_KEY` covers embeddings and reranking;
`LLM_API_KEY` is whatever provider or gateway runs the agent.

Bun and Deno work too. Deno needs `--allow-ffi` for the libsql native binding:

```sh
deno run --allow-ffi --allow-read --allow-write --allow-env --allow-net \
  recipes-extras/hybrid-rag/run-deno.ts "who is Helen Stoner afraid of?"
```

**Run one writer at a time.** The libsql vector index does not tolerate
concurrent writers: two processes ingesting the same file corrupt its shadow
table. Reads are fine.

## Read the trace

Each search prints what every stage did:

```
   dense 100 · lexical 100 · fused 137
   fused top 10 (d = dense leg, l = lexical leg)
     1. [dl] 0.03175  #412
     2. [d-] 0.01639  #97
     3. [-l] 0.01613  #58
   reranked top 5
     1. 0.9871  #412  "It is a swamp adder!" cried Holmes; "the deadliest snake in India."
```

The `[dl]` column shows why you want both legs. Chunks that both found rank
highest. Chunks that only one found are what the other missed: `[-l]` rows are
usually names and rare phrases, `[d-]` rows are paraphrases of the question.

## Make it yours

`recipe.ts` is the only file worth copying. It knows nothing about libsql,
Jina, or any particular way of splitting text: it depends on two ports and the
generic effect-uai tags.

```ts
// implement these for your setup
Chunker // split(text) => passages
ChunkStore // count / add / dense(vector, n) / lexical(query, n)
```

The rest of the folder implements them for this demo: `chunk.ts` splits,
`libsql.ts` stores, `corpus.ts` fetches the book, `app.ts` wires providers and
renders. Already running pgvector with a `tsvector` column, or Qdrant beside
OpenSearch? Implement `ChunkStore` against that and the pipeline does not
change.

Tuning is on the flags: `--per-leg`, `--rerank-depth`, `--keep`, and
`--dense-weight` / `--bm25-weight`. The defaults (100 per leg, rerank 20,
answer from 5, k=60) are a sane production baseline. Weight the lexical leg up
for identifier-heavy corpora (code, SKUs, part numbers), the dense leg up for
prose questions.

## Why bother with two legs

Most RAG examples stop at vector search. That is fine until someone asks about
a name, a code, or a phrase the index has no synonym for. Adding a keyword leg
costs one query and a fusion step, and it is the cheapest recall you will buy.

## See also

- [Retrieve and rerank](/recipes/retrieve-and-rerank/): the same two-stage
  idea without the lexical leg or the database.
- [Reranking](/reranking/): the capability and its score contract.
