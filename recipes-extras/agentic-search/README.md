---
title: Agentic search
description: Word search misses paraphrases, meaning search misses names. Run both, and let the agent search again in its own words.
source: recipes-extras/agentic-search
icon: PiPath
---

Embedding search and keyword search fail in opposite directions.

Ask a vector index for "the speckled band" and it returns passages about snakes,
bell-ropes, and Indian animals: all related, none of them the phrase. Ask BM25
"why did the sister die" and it hunts for words the book never uses. One is good
at meaning, the other at exact strings.

So run both, merge, and rerank what survives. Then hand it to the agent as **a
tool it calls** rather than context stuffed into a prompt, so it can rephrase
and search again when the first try misses.

## The stack

1. **Two legs.** Vector KNN over an `F32_BLOB` column, FTS5 scored by `bm25()`.
   About 100 candidates each.
2. **Fusion by position**, `Rank.rrf` from
   [`@effect-uai/retrieval`](/retrieval/). Positions rather than scores, since
   BM25 and cosine are incomparable scales.
3. **Rerank the fused top 20**, keep 5. Fusion buys recall; this step decides
   which candidate answers the question.
4. **An ordinary agent loop** chooses when to search and what for.

One file on disk. No server, no vector database, no extension loading.

## Run it

```sh
pnpm -C recipes-extras/agentic-search install

JINA_API_KEY=jina_... LLM_API_KEY=sk-... \
  ./recipes-extras/agentic-search/node_modules/.bin/tsx \
  recipes-extras/agentic-search/run-node.ts "why does the speckled band kill?"
```

The first run downloads a public-domain book, chunks it, embeds it, and writes
`rag.db` next to the recipe. Later runs reuse both, so only the first costs
embedding tokens. `JINA_API_KEY` covers embeddings and reranking; `LLM_API_KEY`
is whatever provider or gateway runs the agent.

Bun and Deno work too. Deno needs `--allow-ffi` for the libsql native binding:

```sh
deno run --allow-ffi --allow-read --allow-write --allow-env --allow-net \
  recipes-extras/agentic-search/run-deno.ts "who is Helen Stoner afraid of?"
```

**One writer at a time.** Two processes ingesting the same file corrupt the
vector index's shadow table. Reads are fine.

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

The `[dl]` column is the argument for two legs. Chunks both found rank highest.
Chunks only one found are what the other missed: `[-l]` rows are usually names
and rare phrases, `[d-]` rows are paraphrases of the question.

## Make it yours

`recipe.ts` is the file to copy. It knows nothing about libsql, Jina, or any
way of splitting text, and depends on one port plus the generic effect-uai tags:

```ts
ChunkStore // count / add / dense(vector, n) / lexical(query, n)
```

The rest of the folder is this demo's wiring: `libsql.ts` stores, `corpus.ts`
fetches the book, `app.ts` picks the chunker and providers and renders. Already
running pgvector with a `tsvector` column, or Qdrant beside OpenSearch?
Implement `ChunkStore` against it and the pipeline is unchanged.

Chunking is a layer, so `app.ts` swaps strategies in one line:

```ts
Chunking.layer(Chunking.sentences, { targetSize: 512, overlap: 64 })
```

Tuning is on the flags: `--per-leg`, `--rerank-depth`, `--keep`,
`--dense-weight` / `--bm25-weight`. The defaults (100 per leg, rerank 20, answer
from 5, k=60) are a sane baseline. Weight the lexical leg up for
identifier-heavy corpora (code, SKUs, part numbers), the dense leg up for prose.

## See also

- [Retrieval](/retrieval/): chunking, tokenizers, and rank fusion.
- [Retrieve and rerank](/recipes/retrieve-and-rerank/): the same two stages
  without the lexical leg or the database.
- [Reranking](/reranking/): the capability and its score contract.
