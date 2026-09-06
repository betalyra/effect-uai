---
title: Contextual retrieval
description: Chunking strips each passage of its referents. An LLM writes them back at index time, ahead of both the vector and the keyword leg.
source: recipes-extras/contextual-retrieval
icon: PiNotePencil
---

Chunking throws away everything around the chunk. "The man married a woman very
much older than himself for her money" never names the man, so no question that
does will find it.

[Anthropic's fix](https://www.anthropic.com/engineering/contextual-retrieval):
before indexing, show an LLM the whole document alongside each chunk and ask for
one line situating it. Prepend that line and index the result, in both the
vector and the keyword leg. Here, the same chunk gains "Mr. Windibank, the
stepfather, disguised as Hosmer Angel, from _A Case of Identity_".

This recipe builds a plain index and a contextual one over the same chunks and
runs the same query against both, so the difference is measured rather than
asserted.

## What it costs

One LLM call per chunk, once. Anthropic puts it near $1.02 per million document
tokens with prompt caching, and reports up to 49% fewer retrieval failures
before reranking; independent reproductions land nearer 5 to 15%. Worth it for
corpora that do not churn.

Caching is not optional at this scale: the whole document rides in every call,
so it goes in the system message where it stays byte-identical. The run prints
the cache-read share.

Late chunking is the cheaper neighbour, no LLM pass at all, but it only helps
the vector leg and only on models built for it.

## The prompt

The part to tune. Anthropic's wording, which suits prose:

```
Here is the chunk we want to situate within the whole document:
<chunk>
{chunk}
</chunk>

Please give a short succinct context to situate this chunk within the overall
document for the purposes of improving search retrieval of the chunk.
Answer only with the succinct context and nothing else.
```

For contracts, name the parties and dates. For tickets, product and version.
The blurb should carry the words a searcher would use that the chunk never says.

## Run it

```sh
pnpm -C recipes-extras/contextual-retrieval install

JINA_API_KEY=jina_... ANTHROPIC_API_KEY=sk-ant-... \
  ./recipes-extras/contextual-retrieval/node_modules/.bin/tsx \
  recipes-extras/contextual-retrieval/run.ts "who inherited the estate?"
```

The first run downloads a public-domain book, chunks it, writes a blurb per
chunk, embeds both variants, and stores everything in `rag.db`. That is the
expensive step and it happens once; it resumes where it left off if interrupted.

Any OpenAI-compatible gateway works via `--base-url`, reading `LLM_API_KEY`
instead. Check the cache-read share before you scale it up: the whole document
ships with every call, so a model that caches automatically (DeepSeek reports
98% here) costs about the same as Anthropic, and one that does not costs
roughly a hundred times more.

Bun and Deno work too, Deno needing `--allow-ffi` for the libsql binding:

```sh
deno run --allow-ffi --allow-read --allow-write --allow-env --allow-net \
  recipes-extras/contextual-retrieval/run.ts
```

**One writer at a time.** Two processes ingesting the same file corrupt the
vector index's shadow table.

## Read the output

Both indexes print over the same candidates, and every row says where that
passage landed in the other:

```
  contextual index
   1. 0.6182  #201  He had a passion also for Indian animals, which are…
       NOT RETRIEVED
```

`NOT RETRIEVED` is the interesting row: the plain index never surfaced it at any
depth. Both grounded answers follow, so you see whether the ranking difference
changed what the model could say.

## Make it yours

`recipe.ts` is the file to copy. It depends on one port plus the generic
effect-uai tags:

```ts
ChunkStore // count / add / dense(variant, vector, n) / lexical(variant, query, n)
```

The store takes the variant, so the retrieval code is written once and runs
against either index. `libsql.ts` implements it with two `F32_BLOB` columns and
two FTS5 tables over one row per chunk, so ids line up and a rank movement means
what it looks like. Swap in pgvector or Qdrant without touching the pipeline.

Depths match [agentic search](/recipes/agentic-search/) exactly (100 per leg,
rerank 20, answer from 5) rather than Anthropic's larger ones, so
contextualization is the only variable between the two recipes.

Flags: `--per-leg`, `--rerank-depth`, `--keep`, `--dimensions`, `--model`,
`--base-url`, `--concurrency`.

## See also

- [Agentic search](/recipes/agentic-search/): the same pipeline without the
  indexing-time pass.
- [Retrieval](/retrieval/): the chunking and fusion underneath.
- [Reranking](/reranking/): the last stage, and its score contract.
