# @effect-uai/retrieval

Retrieval-pipeline utilities for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core):
chunking, rank fusion, and a tokenizer layer.

The pieces of a retrieval pipeline that are plain functions rather than
providers. The capability tags they implement (`Chunker`, `Tokenizer`) live in
core, so your ingest code never names a strategy.

This package exposes:

- **`Chunking`** - four chunkers (`recursive`, `sentences`, `markdown`,
  `fixed`), each reporting the offsets every passage came from, so a search hit
  can be traced back to its source. `layer` serves one through the core
  `Chunker` tag; `withTokenizer` sizes chunks by real tokens.
- **`Rank`** - `rrf`, reciprocal rank fusion, for merging a keyword leg and a
  vector leg whose scores mean nothing to each other.
- **`HuggingFaceTokenizer`** - the core `Tokenizer` tag over any Hugging Face
  repo with a `tokenizer.json`. Downloading and building are separate, so you
  cache the vocabulary instead of refetching on every boot.

## Install

```sh
pnpm add @effect-uai/retrieval @effect-uai/core effect
```

The tokenizer needs one optional peer:

```sh
pnpm add @huggingface/tokenizers
```

ESM-only. Requires `effect@4.x` as a peer.

## Usage

```ts
import { chunk } from "@effect-uai/core/Chunker"
import * as Chunking from "@effect-uai/retrieval/Chunking"
import * as Rank from "@effect-uai/retrieval/Rank"

const ingest = Effect.gen(function* () {
  const passages = yield* chunk(document)
  // embed and store
})

const chunker = Chunking.layer(Chunking.recursive, { targetSize: 512 })

const fused = Rank.rrf([keywordIds, vectorIds], { weights: [1, 2] })
```

## Docs

Full docs: <https://effect-uai.betalyra.com/retrieval/>

See [Chunking](https://effect-uai.betalyra.com/retrieval/chunking/),
[Tokenizers](https://effect-uai.betalyra.com/language-models/tokenizers/), and
[Agentic search](https://effect-uai.betalyra.com/recipes/agentic-search/) for a
pipeline using all of it.

## License

MIT
