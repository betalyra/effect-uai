---
title: Retrieval
description: Split documents into passages worth retrieving, size them by real tokens, and merge results from searches that do not share a score scale.
icon: PiCardsThree
---

Before you can retrieve anything you have to cut your documents into passages,
and the cut decides what you can find. Too big and the answer is buried in
noise the embedding averages away. Too small and it loses the context that made
it an answer.

`@effect-uai/retrieval` covers that step and the two around it: sizing passages
by real tokens instead of a guess, and merging results from searches whose
scores cannot be compared.

## Install

```sh
pnpm add @effect-uai/retrieval @effect-uai/core effect
```

## Chunk a document

```ts
import * as Chunking from "@effect-uai/retrieval/Chunking"

const chunks = Chunking.recursive(document, { targetSize: 512 })
// [{ text: "...", start: 0, end: 2043 }, ...]
```

Four chunkers, same signature. Pick by what your documents look like:

|             |                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recursive` | Breaks on paragraphs, then lines, then sentences, then words: whatever is needed to make the pieces fit. Start here. It works on prose you know nothing about. |
| `sentences` | Packs whole sentences, so a passage never ends mid-thought. Good when passages are read back to a model verbatim.                                              |
| `markdown`  | One chunk per `#`..`######` section, keeping each heading with the prose under it. Code samples stay intact.                                                   |
| `fixed`     | Blind windows of a set size. For input with no structure to respect, or when you need a hard ceiling.                                                          |

`targetSize` counts characters over four by default, a rough stand-in for
tokens. `overlap` repeats the tail of each chunk at the head of the next, which
helps when an answer straddles a boundary; 0 to 15% of `targetSize` is the
useful range.

### Find the passage again

Every chunk reports where it came from, and
`document.slice(chunk.start, chunk.end)` gives you back exactly `chunk.text`.
So a search hit can be shown in its surrounding paragraphs, highlighted in the
original document, or paired with a larger enclosing chunk to give a model more
context than it retrieved.

## Change strategy without touching your pipeline

Your ingest code should not care how documents get split. Read the `Chunker`
tag from core and decide at wiring time:

```ts
import { chunk } from "@effect-uai/core/Chunker"
import * as Chunking from "@effect-uai/retrieval/Chunking"

const ingest = Effect.gen(function* () {
  const passages = yield* chunk(document)
  // embed and store
})

const chunker = Chunking.layer(Chunking.markdown, { targetSize: 512 })
```

Swapping `Chunking.markdown` for another chunker, or for a hosted chunking
service, is a one-line change at the edge.

## Count tokens instead of estimating

Characters over four is close enough for English prose and wrong for code, CJK,
and anything with long words. When chunks must fit a real budget, measure with
the model's own tokenizer:

```ts
import * as Chunking from "@effect-uai/retrieval/Chunking"
import * as HuggingFaceTokenizer from "@effect-uai/retrieval/HuggingFaceTokenizer"

const program = Chunking.withTokenizer(Chunking.recursive)(document, { targetSize: 512 })

const tokenizer = HuggingFaceTokenizer.layer({ model: "jinaai/jina-embeddings-v3" })
```

Add the optional peer dependency:

```sh
pnpm add @huggingface/tokenizers
```

Any Hub repo with a `tokenizer.json` works, including OpenAI's through
community conversions like `Xenova/gpt-4o`.

### Load it once, not on every boot

`layer` downloads the vocabulary each time it builds, which is fine for a
script and wasteful in a server. Fetch it once, keep it wherever you keep
things, and build from what you kept:

```ts
import { Definition, download, fromDefinition } from "@effect-uai/retrieval/HuggingFaceTokenizer"

// once: write this to a file, a row, or your bundle
const definition = yield * download({ model: "Xenova/gpt-4o" })

// on every boot
const tokenizer = fromDefinition(yield * Schema.decodeUnknown(Definition)(saved))
```

Some models are gated and only serve their files to accounts that have accepted
the terms. Pass a Hugging Face token for those:

```ts
download({ model: "google/gemma-2-9b", token: yield * Config.redacted("HF_TOKEN") })
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

- [Agentic search](/recipes/agentic-search/): chunking, a keyword leg and a vector leg,
  `rrf`, and reranking, wired as a tool an agent calls.
- [Embeddings](/embeddings/): turn the passages into vectors.
- [Reranking](/reranking/): score the fused shortlist before it reaches the model.
