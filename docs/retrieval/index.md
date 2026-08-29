---
title: Retrieval
description: Turn a corpus and a question into the handful of passages worth putting in a prompt.
icon: PiCardsThree
---

Retrieval is what stands between a corpus and a prompt: split the documents,
find the passages that bear on a question, and cut them down to the few a model
can afford to read.

Each stage is its own tag, so swapping one leaves the others alone.

| Stage                                       | Tag              | Implemented by                               |
| ------------------------------------------- | ---------------- | -------------------------------------------- |
| [Split into passages](/retrieval/chunking/) | `Chunker`        | `@effect-uai/retrieval`, or a hosted service |
| [Turn passages into vectors](/embeddings/)  | `EmbeddingModel` | OpenAI, Gemini, Jina                         |
| Merge rankings that disagree                | none, a function | `Rank.rrf`, below                            |
| [Score the shortlist](/reranking/)          | `Reranker`       | Jina                                         |

The tags live in `@effect-uai/core`. `@effect-uai/retrieval` implements the
chunkers and carries the pieces that are plain functions rather than providers:

```sh
pnpm add @effect-uai/retrieval @effect-uai/core effect
```

## Merge searches that disagree

Keyword search hands you BM25 scores, vector search hands you cosine distances,
and averaging the two numbers is meaningless. Reciprocal rank fusion throws the
scores away and uses positions:

```ts
import * as Rank from "@effect-uai/retrieval/Rank"

const fused = Rank.rrf([keywordIds, vectorIds], { weights: [1, 2] })
// [{ value: 42, score: 0.032 }, ...] best first
```

Weight a leg you trust more. An item that appears in only one list keeps the
credit it earned there rather than being penalised for the absence, so lists of
different lengths fuse fine. Lower `k` (default 60) to make first place count
for more.

Fuse ids or other primitives rather than freshly built objects, which compare
by reference and will not line up across lists.

## See also

- [Chunking](/retrieval/chunking/): the four chunkers, offsets, and the
  `Chunker` tag.
- [Reranking](/reranking/): the last stage, and its score contract.
- [Tokenizers](/language-models/tokenizers/): size chunks by real tokens rather
  than an estimate.
- [Agentic search](/recipes/agentic-search/): every stage above wired together
  as a tool an agent calls.
