# Plan: `@effect-uai/retrieval` (chunking + tokenizer utilities)

One package of retrieval-pipeline utilities: text chunking, rank
fusion, a small in-memory BM25, and the real tokenizer implementation.
The `Tokenizer` service TAG lives in core (zero-dep interface, like
`JSONL` / `Vector`); this package implements and consumes it. Zero
hard dependencies; the HF tokenizer rides an optional peer dependency.
Research behind every decision:
[research/chunking.md](./research/chunking.md).

Committed for v0.13: the hybrid-rag recipe depends on this package
for `rrf`.

## Name

**`@effect-uai/retrieval`.** Considered:

- `retrieval` (chosen): accurate and timeless; chunking, tokenizing,
  and lexical scoring are all retrieval-pipeline preparation, and the
  tokenizer's second life (budget counting) doesn't contradict it.
- `rag`: catchier, matches how users search, but faddish and narrower
  than the contents.
- `chunking`: too narrow once the tokenizer and BM25 are in.
- `text` / `corpus`: too generic.

Module naming inside avoids the `effect/Chunk` collision (keyword
collision rule): the chunking module is `Chunking`, never `Chunk` or
`Chunker`. Modules: `Chunking`, `Rank`, `BM25`, plus the
`HuggingFaceTokenizer` subpath. The `Tokenizer` tag it implements
lives in core.

## What goes in, what stays out

| Piece                                                     | Where                                     | Why                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chunkers (`fixed`, `recursive`, `sentences`, `markdown`)  | package, `Chunking`                       | Pure sync, zero deps.                                                                                                                                                                                                                                                |
| `Tokenizer` tag + `approximate` default                   | **core**, `Tokenizer`                     | Zero-dep interface + chars/4 layer; token counting serves budgets/compaction beyond retrieval, and consumers should not depend on a package named `retrieval` for it.                                                                                                |
| HF-backed tokenizer layer                                 | package, `./HuggingFaceTokenizer` subpath | Optional peer dep on `@huggingface/tokenizers`; implements the core tag.                                                                                                                                                                                             |
| In-memory BM25                                            | package, `BM25`                           | Completes the no-DB hybrid story; see scope fence below.                                                                                                                                                                                                             |
| `Rank.rrf`                                                | **package**, `Rank`                       | Moves out of core (decided): `core/src/math/Rank.ts` and the `./Rank` export are unpublished, so the move is free. Only the hybrid-rag recipe uses it, and it belongs with BM25 as pipeline fusion, not in core. Delete the core file/export when the package lands. |
| `Vector`                                                  | stays in core                             | Embedding-adjacent core domain (embedding responses consume it).                                                                                                                                                                                                     |
| Semantic chunking                                         | out (v2 candidate)                        | Consumes `EmbeddingModel`; only credible later addition.                                                                                                                                                                                                             |
| Code/AST, PDF/layout, late chunking, contextual retrieval | out                                       | Deps, extraction, model-specific, recipe respectively.                                                                                                                                                                                                               |
| Any tokenizer implementation of our own                   | out, permanently                          | We wrap, we never implement BPE.                                                                                                                                                                                                                                     |

## `Tokenizer` service (tag in core)

The remote-capability question was researched and rejected: remote
APIs don't unify (OpenAI has no endpoint; Anthropic/Gemini count
whole requests, not text; only Cohere v1 tokenizes text). So this is
a local-implementation service. The TAG and the approximate default
live in core (decided): token counting serves usage estimation and
budget/compaction concerns that have nothing to do with retrieval,
and a tag plus a chars/4 layer is zero-dependency interface code,
the same footprint as `JSONL` or `Vector`.

Full tokens, not just counts (decided): downstream uses beyond
chunking (estimating usage when a provider reports none or reports
late) want token ids.

```ts
// core: packages/core/src/tokenizer/Tokenizer.ts, exported ./Tokenizer
export interface TokenizerService {
  readonly encode: (text: string) => ReadonlyArray<number>
  readonly decode: (tokens: ReadonlyArray<number>) => string
  readonly count: (text: string) => number
}

export class Tokenizer extends Context.Tag("@betalyra/effect-uai/Tokenizer")<
  Tokenizer,
  TokenizerService
>() {}

/** chars/4 heuristic. See open question 1 on encode/decode honesty. */
export const approximate: Layer.Layer<Tokenizer>
```

All methods sync: construction is where async lives, counting is per
sentence and must never await. `approximate.count` is the chunkers'
default measure; whether `approximate` should even offer
encode/decode (vs a count-only default and a narrower `Measure`
contract for chunking) is an open question for implementation, leaning
count-only-honesty: a fake `encode` invites misuse.

## `HuggingFaceTokenizer` (the one real implementation)

`@huggingface/tokenizers` verified: zero dependencies, 301KB, 1.45M
weekly downloads, official HF maintainers, pure JS (v0.1.x, young).
It does NOT download; it takes `tokenizer.json` content. That is our
job, through the platform:

```ts
// subpath: @effect-uai/retrieval/HuggingFaceTokenizer
// optional peerDependency: @huggingface/tokenizers

/** Fetch tokenizer.json (and tokenizer_config.json) from the HF Hub via HttpClient. */
export const layer: (options: {
  readonly model: string // e.g. "Xenova/gpt-4o", "jinaai/jina-embeddings-v3"
  readonly revision?: string
}) => Layer.Layer<Tokenizer, McpishError, HttpClient.HttpClient>

/** Offline: caller already holds the JSON (bundled, cached, air-gapped). */
export const fromJson: (
  tokenizerJson: unknown,
  tokenizerConfigJson?: unknown,
) => Layer.Layer<Tokenizer>
```

- Download via `effect/unstable/http` `HttpClient` at layer
  construction (`Layer.effect`), from
  `https://huggingface.co/<model>/resolve/<revision>/tokenizer.json`.
  Requirement surfaces in the layer type; no hidden fetch.
- No tiktoken adapter: OpenAI tokenizers exist as community
  `tokenizer.json` conversions (e.g. Xenova's), so HF covers
  everything. Document that in the README with one example.
- No caching in v1 (the caller can `fromJson` a saved file); revisit
  if demand shows.
- Verify Bun/Deno empirically during implementation (pure JS, should
  pass; undocumented upstream).
- Error type: typed error on fetch/parse failure; no `AiError` (this
  package is not a provider).

## `Chunking`

Per the research: pure sync, provenance offsets, overlap default low.

```ts
export type Measure = (text: string) => number // default: chars/4

export type Chunk = {
  readonly text: string
  readonly start: number // char offset into the input
  readonly end: number
}

export type Options = {
  readonly targetSize?: number // in measure units, default 512
  readonly overlap?: number // in measure units, default 0
  readonly measure?: Measure
}

export const fixed: (text: string, options?: Options) => ReadonlyArray<Chunk>
export const recursive: (text: string, options?: Options) => ReadonlyArray<Chunk>
export const sentences: (text: string, options?: Options) => ReadonlyArray<Chunk>
export const markdown: (text: string, options?: Options) => ReadonlyArray<Chunk>

/** Sugar: pull Tokenizer from context, chunk with its count as measure. */
export const withTokenizer: (
  chunker: (text: string, options?: Options) => ReadonlyArray<Chunk>,
) => (
  text: string,
  options?: Omit<Options, "measure">,
) => Effect.Effect<ReadonlyArray<Chunk>, never, Tokenizer>
```

- `recursive` is the documented default (the evidence-backed
  baseline); `sentences` generalizes the hybrid-rag recipe chunker;
  `markdown` splits on header hierarchy with size caps.
- Overlap defaults to 0 (the research demoted it); the docs say
  0-15% is the defensible range.
- Option is named `targetSize`, documented as "units of `measure`,
  approximately tokens with the default": avoids the LangChain
  chars-vs-tokens footgun by being explicit.

## `BM25`

Previously ruled out of **core** ("a good BM25 is a search engine").
In this package a deliberately small in-memory Okapi BM25 is
defensible and completes the story: chunk + embed + cosine (core) +
BM25 (here) + `Rank.rrf` (here) + `Reranker` = full hybrid retrieval
with no database.

```ts
export type Index // opaque; frozen after build

export const make: (
  documents: ReadonlyArray<string>,
  options?: {
    readonly tokenize?: (text: string) => ReadonlyArray<string> // default: lowercase word split
    readonly k1?: number // 1.2
    readonly b?: number // 0.75
  },
) => Index

export const search: (index: Index, query: string, topN?: number) => ReadonlyArray<{ readonly index: number; readonly score: number }>
```

**Scope fence (the whole defense against the search-engine cliff):**
default tokenization is lowercase word splitting, injectable, and
that is it. No stemming, no stopword lists, no CJK segmentation, no
incremental updates, no persistence; the docs state plainly that at
scale or for quality, a database's FTS (the hybrid-rag recipe's FTS5
leg) does this better. Requests for those features get a docs pointer,
not code.

## Core changes bundled with this plan

- Add `packages/core/src/tokenizer/Tokenizer.ts` (tag +
  `approximate`), exported at `./Tokenizer`.
- Remove `packages/core/src/math/Rank.ts`, its test, and the
  `./Rank` export; the module moves here as `Rank`. Unpublished, so
  no migration note is needed; update the hybrid-rag recipe import.

## Package mechanics

- `packages/retrieval/` (not `packages/providers/`: it is not a
  provider). Exports: `.`, `./Chunking`, `./Rank`, `./BM25`,
  `./HuggingFaceTokenizer`.
- Dependencies: none. `peerDependencies`: `effect` (catalog) and
  `@effect-uai/core` (workspace range, for the `Tokenizer` tag), plus
  `@huggingface/tokenizers` marked optional in `peerDependenciesMeta`;
  only the `./HuggingFaceTokenizer` subpath imports it, so
  non-consumers never install or load it.
- Joins the changeset fixed group at the current group version.
- Docs: a docs-site section (probably under Embeddings or a new
  "Retrieval" group) written user-POV; recipes updated to consume it
  (hybrid-rag's `chunk.ts` becomes an import and its `rrf` import
  moves to this package; a future in-memory hybrid variant of
  `retrieve-and-rerank` becomes possible).
- Tests: chunker boundary/overlap/provenance against real texts,
  markdown header nesting, BM25 against hand-computed scores, `rrf`
  tests move with the module, tokenizer layer against a stubbed
  HttpClient serving a real small `tokenizer.json` fixture,
  `expectTypeOf` inline.

## Open questions

1. `approximate`: count-only vs fake encode/decode (leaning
   count-only; see above).
2. Whether `withTokenizer` sugar earns its place or callers just
   write the two lines (leaning: include, it is the discoverable
   bridge between the service and the pure functions).

## Out of scope

Semantic chunking (v2, as `Effect<..., ..., EmbeddingModel>`),
code/AST chunking, PDF extraction, late chunking, contextual
retrieval (future recipe), remote tokenization providers, any BPE
implementation of our own, caching downloaded tokenizers.
