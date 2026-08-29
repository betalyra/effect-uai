# Research: chunking (utilities package decision)

Findings for [chunking-plan.md](./chunking-plan.md). Methods and
benchmarks from 2025-2026 primary sources; ecosystem survey from npm
registry data (download window 2026-08-22 to 2026-08-28). UNVERIFIED
flags carried through.

## Verdict up front

> Superseded in part: the settled package design (single
> `@effect-uai/retrieval` package with a `Tokenizer` service, HF layer
> over the platform HttpClient, and an in-memory BM25) lives in
> [plans/chunking.md](../chunking.md). This document remains the
> evidence base.

**Ship it: a small, separate, zero-dependency package.** The Effect
niche is literally empty, every mainstream TS option is
framework-locked or drags a multi-megabyte tokenizer, and no existing
library makes the injected-measure design its core. Scope pinned to
four structural splitters plus an injected `(text) => number` measure
with a chars/4 default. No tokenizer dependency, ever; document
`@huggingface/tokenizers` and `gpt-tokenizer` as opt-in measure
functions. Semantic chunking, code/AST, and PDF stay out of v1
(semantic chunking is the one credible v2 candidate, as an
Effect-based function consuming `EmbeddingModel`).

Honest ceiling: structural chunking is commodity algorithm territory.
This wins nothing outside the Effect world; its value is (a) the
Effect ecosystem draw and (b) our own recipes dogfooding it.

## Q1. Methods: what the 2025-2026 evidence says

The baseline hardened. Peer-reviewed and end-to-end results agree
that **recursive or sentence-boundary splitting at ~400-512 tokens is
the default that mostly ties or beats everything fancier**:

- Vectara (NAACL 2025 Findings): semantic chunking's compute is "not
  justified by consistent performance gains"; fixed ~200 words
  matches or beats it end to end.
- FloTorch/PremAI 2026 benchmark: recursive 512 tokens 69% end-to-end
  accuracy, fixed 512 67%, semantic 54%. Recall-only evals (where
  semantic looks great) invert once answer accuracy is measured.
- Chroma (July 2024, still the most-cited eval): recursive at 200-400
  tokens within 2-4 recall points of the best LLM/semantic chunkers
  at zero cost.
- **Overlap got demoted**: Chroma found no overlap best at 400
  tokens; a 2026 analysis found overlap "no measurable benefit, only
  indexing cost" (secondhand via PremAI/Firecrawl, primary source
  untraced). 0-15% is the defensible range. Our v0-13 plan says
  10-20%; soften to "0-15%, default modest".

Where the fancier methods actually win:

- **Structure-aware wins clearly on structured input**: AST-boundary
  chunking for code (cAST, EMNLP 2025: +4.3 Recall@5 RepoEval, +2.67
  Pass@1 SWE-bench, replicated), markdown-header splitting for
  structured prose (unanimous vendor guidance), page-level for
  paginated business PDFs (NVIDIA).
- **Semantic chunking** (embedding-similarity breakpoints, 10-50x
  embedding cost): wins only on topically heterogeneous flat text
  without formatting cues, and needs a minimum-size floor to avoid
  ~43-token fragments (single source, UNVERIFIED).
- **Late chunking** (Jina): complements, does not replace: you still
  pick boundaries, it changes how chunks are embedded. Tied to
  specific long-context embedding models, does not help the BM25 leg.
  Average +3.63% relative nDCG, concentrated on long documents.
- **Contextual retrieval** (Anthropic-style LLM blurb per chunk): the
  expensive tier for static high-value corpora; Anthropic quotes 35%
  fewer retrieval failures alone, 67% with reranking; independent
  2025-2026 reproductions report a more modest 5-15%. Indexing-time
  LLM cost; only amortizes if the corpus does not churn. Recipe
  material for us (it composes `LanguageModel` + chunking), not API
  surface.

## Q2. The tokenizer question: injection wins

**No published evidence that token-exact sizing beats chars/4 for
retrieval quality.** Chunk-size sensitivity is a broad plateau
(NVIDIA and 2026 pipeline studies), so a ~25% counting error stays
inside it. Real tokenizers matter operationally, not for quality:

- OpenAI embeddings **reject** over-long inputs (400 error, no
  truncate option); Cohere, Voyage, and Vertex **silently truncate**
  by default, losing chunk tails invisibly. Token-aware sizing is
  about limits, not better chunks.
- The LangChain-style units footgun (`chunk_size: 512` silently
  meaning characters, producing 4x-too-small chunks) hurts quality;
  that is a units bug, not a precision issue. Name our option
  unambiguously (`targetTokens` with documented approximation, or
  `measure`-relative units).

Tokenizer landscape for the docs (opt-in measure functions):

| Package                      | Kind                                     | Notes                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@huggingface/tokenizers`    | Pure JS, zero deps, ~301KB / ~8.3kB gzip | The 2025/26 standalone tokenizers.js (v0.1.3, Mar 2026); loads arbitrary HF `tokenizer.json`, so it covers embedding models' real tokenizers. What transformers.js v4 uses internally (1.45M weekly). Young (0.1.x); Bun/Deno/edge undocumented but zero-dep pure JS (verify empirically at adoption time). |
| `gpt-tokenizer`              | Pure TS, zero deps                       | OpenAI encodings only; very active (v4, Aug 2026); weight is BPE rank data (MBs per encoding), per-encoding entrypoints.                                                                                                                                                                                    |
| `js-tiktoken`                | Pure JS                                  | The one everyone hard-bundles (LangChain, Mastra, LlamaIndex); OpenAI encodings only.                                                                                                                                                                                                                       |
| `tokenizers` (HF native npm) | Native bindings                          | Dead since May 2023; classic platform-binary problems. Avoid.                                                                                                                                                                                                                                               |
| `@huggingface/transformers`  | ONNX + native                            | Disqualified: huge, not platform-neutral (per project owner, confirmed by native sharp/onnxruntime deps).                                                                                                                                                                                                   |

**Design consequence**: ship no tokenizer. Core design is an injected
`measure: (text: string) => number` defaulting to chars/4. Precedent
exists (LangChain's optional `lengthFunction`, LlamaIndex's
`tokenizer` option, chonkie's char default) but **no library makes it
the core design**; every mainstream one hard-bundles js-tiktoken or
transformers anyway.

## Q3. Ecosystem: the gap is real and Effect-specific

- **`@langchain/textsplitters`** (1.9M weekly): NOT standalone (peer
  `@langchain/core`, splitters produce LangChain `Document`s),
  class-based, async even for pure-CPU splits, hard-deps `js-tiktoken`
  (~22MB) whether used or not. Splitters: character, recursive (+
  code languages), token, markdown, LaTeX.
- **LlamaIndex.TS**: semi-standalone (`@llamaindex/core` without the
  meta-package) but drags zod + `@llamaindex/env` (hard `js-tiktoken`,
  AWS crypto shims); class hierarchy over `TextNode` abstractions.
- **`@mastra/rag`** (135k weekly, very active): broadest strategy
  coverage (nine, incl. semantic-markdown) but peer-locked to
  `@mastra/core`, and hard-deps include an AWS Bedrock SDK client in
  a chunking package.
- **chonkie TS**: old `chonkie` npm is 14 months stale with hard
  `@huggingface/transformers`. Successor `@chonkiejs/core` (17.6k
  weekly, June 2026) is the only healthy standalone: small and typed
  but OOP with async factories, WASM at the center (`await init()`),
  0.0.x with a package-identity migration behind it, char-based
  counting by default, and semantic chunking upsold to a paid cloud
  API.
- **`llm-chunk`**: the closest thing to small-typed-pure-sync, and it
  is abandoned at v0.0.1 (Sept 2023) while still pulling 7.8k weekly:
  evidence of demand for exactly this shape.
- **Effect ecosystem: nothing.** No Effect-flavored splitter or
  chunking library exists; `@effect/ai` has none (consistent across
  searches, not directly inspected).

Gap statement: no package offers pure sync functions + zero hard deps

- measure injection as the core design + no framework peer lock.
  Everything mainstream imposes exactly the costs the project owner
  named: framework coupling, batteries (PDF readers, AWS clients),
  platform-dependent tokenizers.

## Q4. Package fit

- **Separate package, not core** (owner preference, and correct):
  core stays capabilities + zero-dep primitives; a future semantic
  chunker consuming `EmbeddingModel` would make core a consumer of
  its own capabilities, which the separate package can do freely.
- **Naming**: effect itself ships a `Chunk` data type, so avoid
  `Chunk`/`Chunker` as the package or module identity
  (keyword-collision rule). Working name: `@effect-uai/chunking`.
  Function names `fixed`, `recursive`, `sentences`, `markdown` under
  a module whose name does not collide with `effect/Chunk`.
- **v1 surface** (pure sync, zero deps, platform-neutral by
  construction):
  - `fixed(text, opts)`: window + optional overlap.
  - `recursive(text, opts)`: separator hierarchy (paragraph, line,
    sentence, word), the evidence-backed default.
  - `sentences(text, opts)`: sentence packing (generalizes the
    hybrid-rag recipe chunker).
  - `markdown(text, opts)`: header-hierarchy sections with size caps.
  - Shared opts: `measure?: (text: string) => number` (default
    chars/4), `targetSize`, `overlap` (default 0 or small, per the
    evidence), and chunk provenance (start/end offsets) so callers
    can map chunks back to sources.
  - Docs show wiring `@huggingface/tokenizers` / `gpt-tokenizer` as
    `measure`.
- **Out of v1**: semantic (v2 candidate as
  `Effect<..., ..., EmbeddingModel>`), code/AST (tree-sitter dep,
  against the zero-dep point), PDF/layout (extraction, different
  problem), late chunking (model-specific), contextual retrieval
  (recipe, not API).
- **Dogfooding**: `recipes-extras/hybrid-rag/chunk.ts` becomes an
  import; `retrieve-and-rerank` can stay corpus-inline. A future
  contextual-retrieval recipe composes this package with
  `LanguageModel`.
- **Versioning**: joins the fixed group at the current group version
  when it debuts (house rule for new packages).
- **Timing**: not required for v0.13 (the recipes carry their own
  40-line chunker). Fits v0.13's retrieval theme as a small S item if
  slack exists after items 1-2b; otherwise an early v0.14 item.
  Decision deliberately left out of plans/v0-13.md pending owner
  call.

## Risks

- Scope creep is the failure mode: a public chunking API invites
  markdown-edge-case, code-aware, and PDF requests. The v1 boundary
  above is the defense; code/AST and extraction stay permanently out
  (point at cAST/astchunk and extraction tools in docs).
- `@huggingface/tokenizers` is 0.1.x; recommend it in docs with the
  caveat, verify Bun/Deno empirically before naming it there.
- Commodity risk accepted: this is an Effect-ecosystem play, not a
  general-market one.
