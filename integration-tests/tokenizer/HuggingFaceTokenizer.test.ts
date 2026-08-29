/**
 * Live against the Hugging Face Hub: no fixtures, no stub client. Every
 * assertion here is one a fake vocabulary would pass and a real one might not.
 */
import { NodeFileSystem } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { Array as Arr, Context, Effect, FileSystem, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "vitest"
import { Tokenizer } from "@effect-uai/core/Tokenizer"
import { recursive, withTokenizer } from "@effect-uai/retrieval/Chunking"
import {
  Definition,
  download,
  fromDefinition,
  layer as tokenizerLayer,
  TokenizerLoadError,
} from "@effect-uai/retrieval/HuggingFaceTokenizer"

// Both are small, public, and ungated: no token, no terms to accept.
const QWEN = "Qwen/Qwen3-0.6B"
const SMOL = "HuggingFaceTB/SmolLM2-135M"

const PROSE = `Retrieval-augmented generation, in Effect.

The tokenizer decides what a chunk costs. A character estimate is close
enough to eyeball and wrong enough to blow a context window, so the budget
is counted over the same vocabulary the model reads.

Emoji, accents, and CJK are where estimates fall apart: café 🚀 東京.`

const CACHE = ".cache/tokenizers"

const stored = Schema.fromJsonString(Definition)

/**
 * Downloaded on the first run and kept on disk, the way an application would
 * keep it. Delete `node_modules/.cache/tokenizers` to fetch again.
 */
const cached = (model: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = `${CACHE}/${model.replaceAll("/", "_")}.json`
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(stored)),
      // A missing or corrupt cache is just a miss.
      Effect.catchCause(() =>
        Effect.tap(download({ model }), (fresh) =>
          fs
            .makeDirectory(CACHE, { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(file, JSON.stringify(fresh)))),
        ),
      ),
    )
  })

/** Loaded once for the whole suite; each test builds a tokenizer from these. */
class Vocabularies extends Context.Service<
  Vocabularies,
  { readonly qwen: Definition; readonly smol: Definition }
>()("test/Vocabularies") {}

const vocabularies = Layer.effect(
  Vocabularies,
  Effect.all({ qwen: cached(QWEN), smol: cached(SMOL) }),
).pipe(Layer.provide([FetchHttpClient.layer, NodeFileSystem.layer]))

layer(vocabularies, { timeout: "2 minutes" })("HuggingFaceTokenizer", (it) => {
  it.effect("round-trips text through a real vocabulary", () =>
    Effect.gen(function* () {
      const texts = ["Retrieval-augmented generation, in Effect.", "café 🚀 東京", "  ", ""]
      const { qwen } = yield* Vocabularies

      const result = yield* Effect.provide(
        Effect.map(Tokenizer, (it) => ({
          decoded: Arr.map(texts, (text) => it.decode(it.encode(text))),
          empty: it.encode(""),
        })),
        fromDefinition(qwen),
      )

      expect(result.decoded).toEqual(texts)
      // No special tokens are bolted on, so a count is the count of the text alone.
      expect(result.empty).toEqual([])
    }),
  )

  it.effect("gives different ids per model for the same text", () =>
    Effect.gen(function* () {
      const text = "Retrieval-augmented generation, in Effect."
      const encode = Effect.map(Tokenizer, (it) => it.encode(text))
      const vocab = yield* Vocabularies

      const a = yield* Effect.provide(encode, fromDefinition(vocab.qwen))
      const b = yield* Effect.provide(encode, fromDefinition(vocab.smol))

      expect(a).not.toEqual(b)
      expect(a.length).toBeGreaterThan(0)
      expect(b.length).toBeGreaterThan(0)
    }),
  )

  it.effect("rebuilds from a definition that has been through JSON", () =>
    Effect.gen(function* () {
      const encode = Effect.map(Tokenizer, (it) => it.encode(PROSE))
      const { smol } = yield* Vocabularies
      // What an application holds instead of re-downloading: a row, a file, a
      // bundled asset. Decoded back through the schema, as it would be on read.
      const stored = yield* Schema.decodeUnknownEffect(Definition)(JSON.parse(JSON.stringify(smol)))

      const cached = yield* Effect.provide(encode, fromDefinition(stored))
      const live = yield* Effect.provide(encode, fromDefinition(smol))

      expect(cached).toEqual(live)
    }),
  )

  it.effect("budgets chunks by real tokens, not by an estimate", () =>
    Effect.gen(function* () {
      const targetSize = 24
      const { qwen } = yield* Vocabularies

      const { chunks, sizes } = yield* Effect.provide(
        Effect.gen(function* () {
          const chunks = yield* withTokenizer(recursive)(PROSE, { targetSize })
          const tokenizer = yield* Tokenizer
          return {
            chunks,
            sizes: Arr.map(chunks, (it) => tokenizer.encode(it.text).length),
          }
        }),
        fromDefinition(qwen),
      )

      expect(chunks.length).toBeGreaterThan(1)
      expect(Arr.filter(sizes, (size) => size > targetSize)).toEqual([])
      // Offsets index the input, so a chunk can always be traced back to it.
      expect(Arr.filter(chunks, (it) => PROSE.slice(it.start, it.end) !== it.text)).toEqual([])
    }),
  )
})

describe("download", () => {
  it.effect(
    "builds a working tokenizer in one step",
    () =>
      Effect.gen(function* () {
        const ids = yield* Effect.provide(
          Effect.map(Tokenizer, (it) => it.encode("one step")),
          tokenizerLayer({ model: SMOL }).pipe(Layer.provide(FetchHttpClient.layer)),
        )

        expect(ids.length).toBeGreaterThan(0)
      }),
    { timeout: 120_000 },
  )

  it.effect("fails with TokenizerLoadError on a repo that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(download({ model: "effect-uai/no-such-tokenizer" }))

      expect(error).toBeInstanceOf(TokenizerLoadError)
      expect(error.model).toBe("effect-uai/no-such-tokenizer")
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  )
})
