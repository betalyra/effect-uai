# Research plan: chunking (utilities package decision)

Whether text chunking deserves a place in effect-uai (a
`@effect-uai/chunking`-style utilities package, core module, or
nothing), and what the main methods are today. Findings land in
`plans/research/chunking.md`.

## Context

The hybrid-rag recipe (v0.13 item 2b) ships a ~40-line
sentence-boundary chunker
([recipes-extras/hybrid-rag/chunk.ts](../../recipes-extras/hybrid-rag/chunk.ts)):
approximate tokens as chars/4, split on sentence punctuation, carry
N sentences of overlap. Good enough for a demo; the question is
whether users' real pipelines need more and whether we should be the
ones shipping it.

## Questions

### Q1. State of the art: the main methods

The mainstream taxonomy only, no niche research: fixed-size,
recursive (separator hierarchy), sentence/paragraph, structure-aware
(markdown/HTML/code), semantic (embedding-similarity breakpoints),
late chunking (Jina), contextual retrieval (Anthropic-style LLM
context prepending), page/layout-based for PDFs. For each: what it
is in two sentences, cost, and what the 2025-2026 benchmarks say
about when it actually wins. Where do current evaluations land on
"recursive/sentence at ~400-512 tokens is the baseline that mostly
ties semantic"?

### Q2. The tokenizer question

A real chunker sizes by tokens. What do TS libraries use: js-tiktoken
/ gpt-tokenizer (pure JS, which sizes and speeds), WASM tokenizers,
chars/4 approximation? Is token-exact sizing actually needed for
retrieval quality, or is approximate fine (evidence)? This decides
whether a chunking package drags in a tokenizer dependency, which
collides with our zero-deps core.

### Q3. TS ecosystem: what exists already

What a user reaches for today: LangChain's text splitters (standalone
`@langchain/textsplitters`?), LlamaIndex.TS node parsers, Mastra
chunking, chonkie (and its TS port status), llm-chunk,
semantic-chunking npm, anything Effect-flavored. Maintenance state,
dependency weight, API shape. Is there a gap a small, typed,
zero-dependency, Effect-idiomatic chunking module would fill, or is
this a solved commodity where we would be library number nine?

### Q4. Package-fit against our own rules (in-repo, my call)

- Core is capabilities + primitives with zero provider deps; `math/`
  ships pure functions (`Vector`, `Rank`). Pure sync chunkers
  (fixed/recursive/sentence/markdown) would fit that pattern; semantic
  chunking needs `EmbeddingModel` (a capability consumer, new
  territory for core); contextual retrieval needs `LanguageModel`.
- Separate package vs core module: our rules say no separate package
  for a few hundred lines of pure functions (the `@effect-uai/math`
  argument), but a tokenizer dependency would force the split.
- Who consumes it in-repo: hybrid-rag, retrieve-and-rerank, future
  RAG-adjacent recipes; does the embeddings docs page want it?

## Method

1. In-repo sweep (Q4) plus read the existing chunk.ts.
2. One agent on Q1 (+Q2 evidence): methods and benchmarks, 2025-2026
   sources.
3. One agent on Q3 (+Q2 library survey): TS ecosystem, npm state.
4. Findings doc with a concrete recommendation: ship nothing / core
   module / separate package, and if shipping, the v1 API surface.

## Out of scope

- Implementing anything.
- PDF/OCR extraction (upstream of chunking, different problem).
- Changing the shipped recipe chunker as part of this research.
