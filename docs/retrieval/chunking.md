---
title: Chunking
description: Split documents into retrievable passages, with the offsets to find them again.
---

The cut decides what you can find. Too big and the answer is buried in noise the
embedding averages away. Too small and it loses the context that made it an
answer.

```ts
import * as Chunking from "@effect-uai/retrieval/Chunking"

const chunks = Chunking.recursive(document, { targetSize: 512 })
// [{ text: "...", start: 0, end: 2043 }, ...]
```

Four chunkers, same signature. Pick by what your documents look like:

| Chunker     | Reach for it when                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recursive` | Breaks on paragraphs, then lines, then sentences, then words: whatever is needed to make the pieces fit. Start here. It works on prose you know nothing about. |
| `sentences` | Packs whole sentences, so a passage never ends mid-thought. Good when passages are read back to a model verbatim.                                              |
| `markdown`  | One chunk per `#`..`######` section, keeping each heading with the prose under it. Code samples stay intact.                                                   |
| `fixed`     | Blind windows of a set size. For input with no structure to respect, or when you need a hard ceiling.                                                          |

`targetSize` counts characters over four by default, a rough stand-in for
tokens. `overlap` repeats the tail of each chunk at the head of the next, which
helps when an answer straddles a boundary; 0 to 15% of `targetSize` is the
useful range.

To count real tokens instead of estimating, hand the chunker a
[tokenizer](/language-models/tokenizers/):

```ts
Chunking.withTokenizer(Chunking.recursive)(document, { targetSize: 512 })
```

## Find the passage again

Every chunk reports where it came from, and
`document.slice(chunk.start, chunk.end)` gives you back exactly `chunk.text`.
So a search hit can be shown in its surrounding paragraphs, highlighted in the
original document, or paired with a larger enclosing chunk to give a model more
context than it retrieved.

Overlap makes chunks share regions, never lose them.

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

## See also

- [Retrieval](/retrieval/): rank fusion, and the rest of the package.
- [Tokenizers](/language-models/tokenizers/): size chunks by real tokens.
- [Contextual retrieval](/recipes/contextual-retrieval/): what chunking throws
  away, and writing it back at index time.
