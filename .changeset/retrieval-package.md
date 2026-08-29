---
"@effect-uai/core": minor
"@effect-uai/retrieval": minor
---

Add `@effect-uai/retrieval`, the step before embedding: split documents into
passages, size them by real tokens, and merge results from searches that do not
share a score scale.

Core gains two capability tags for it. `Chunker` (`@effect-uai/core/Chunker`)
splits a document into `Chunk`s, so ingest code never names a strategy and a
hosted chunking service can replace a local splitter at the layer.
`Tokenizer` (`@effect-uai/core/Tokenizer`) encodes and decodes text.

```ts
import { chunk } from "@effect-uai/core/Chunker"
import * as Chunking from "@effect-uai/retrieval/Chunking"

const ingest = Effect.gen(function* () {
  const passages = yield* chunk(document)
})

const chunker = Chunking.layer(Chunking.recursive, { targetSize: 512 })
```

`Chunking` ships four chunkers, all pure and all reporting the offsets each
passage came from, so a hit can be traced back to its source: `recursive`
(the default, breaking on paragraphs then lines then sentences then words),
`sentences`, `markdown` (one chunk per heading, leaving fenced code intact),
and `fixed`.

`Rank.rrf` is reciprocal rank fusion, for combining a keyword leg and a vector
leg whose scores mean nothing to each other:

```ts
import * as Rank from "@effect-uai/retrieval/Rank"

Rank.rrf([lexicalIds, denseIds], { weights: [1, 0.7] })
// => [{ value: id, score }, ...] best first
```

`HuggingFaceTokenizer` implements `Tokenizer` over any Hub repo with a
`tokenizer.json`, behind an optional peer dependency on
`@huggingface/tokenizers`. Downloading and building are separate, so you cache
the vocabulary wherever you already keep things instead of refetching on every
boot, and gated repos take an access token.
