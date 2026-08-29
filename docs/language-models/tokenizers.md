---
title: Tokenizers
description: Count text over a model's real vocabulary, for prompt budgets and chunk sizes.
---

`Tokenizer` is the core tag for counting text over a model's own vocabulary.
Two methods, both synchronous, so counting inside a loop never awaits:

```ts
import { Tokenizer } from "@effect-uai/core/Tokenizer"

const size = Effect.map(Tokenizer, (tokenizer) => tokenizer.encode(text).length)
```

`decode` inverts `encode`. There is no `count`: it is `encode(text).length`.

Reach for it when something has to fit a budget. `usage` tells you what a turn
cost once it is over; counting beforehand is how you decide what to send.

## Hugging Face vocabularies

`HuggingFaceTokenizer` implements the tag over any Hub repo with a
`tokenizer.json`, including OpenAI's through community conversions like
`Xenova/gpt-4o`:

```ts
import * as HuggingFaceTokenizer from "@effect-uai/retrieval/HuggingFaceTokenizer"

const tokenizer = HuggingFaceTokenizer.layer({ model: "Qwen/Qwen3-0.6B" })
```

It ships in `@effect-uai/retrieval`, behind an optional peer dependency:

```sh
pnpm add @effect-uai/retrieval @huggingface/tokenizers
```

Pure JavaScript, no native build step.

## Load it once, not on every boot

`layer` downloads the vocabulary each time it builds, which is fine for a script
and wasteful in a server. Fetching and building are separate for that reason:

```ts
import { Definition, download, fromDefinition } from "@effect-uai/retrieval/HuggingFaceTokenizer"

// once: write this to a file, a row, or your bundle
const prefetch = Effect.gen(function* () {
  const definition = yield* download({ model: "Qwen/Qwen3-0.6B" })
  yield* save(JSON.stringify(definition))
})

// on every boot
const tokenizer = Layer.unwrap(
  Effect.map(Schema.decodeUnknownEffect(Definition)(saved), fromDefinition),
)
```

`Definition` is plain JSON and a schema, so it round-trips through anything that
stores text. Nothing here touches the filesystem or caches behind your back.

## Gated repositories

Some models serve their files only to accounts that have accepted the model's
terms, Google's among them. Pass a Hugging Face token for those:

```ts
const gated = Effect.gen(function* () {
  const token = yield* Config.redacted("HF_TOKEN")
  return yield* download({ model: "google/gemma-2-9b", token })
})
```

Without one the Hub answers 401 or 403, and `download` fails with
`TokenizerLoadError` naming the model.

## Sizing chunks

The other use. Hand a chunker the tag and `targetSize` counts tokens instead of
estimating them:

```ts
import * as Chunking from "@effect-uai/retrieval/Chunking"

const program = Chunking.withTokenizer(Chunking.recursive)(document, { targetSize: 512 })
```

See [retrieval](/retrieval/) for the chunkers themselves.
