# Research plan: reranking (v0.13 item 1)

How to research the `Reranker` capability before designing it. This is
the plan for the research, not the research itself; findings land in
`plans/research/reranking.md`.

## Prior findings (re-verify, they're months old)

From [plans/embeddings.md](../embeddings.md), "Rerank API shape
(forward look)". Treat these as hypotheses to confirm against current
docs, not as settled facts; model generations in particular move:

- All four rerank-capable providers we tracked (Cohere, Jina, Voyage,
  Mixedbread) converge on
  `POST /rerank { model, query, documents, top_n?, return_documents? } → { results: [{ index, relevance_score }] }`.
- Reranker is a sibling service to `EmbeddingModel`: same per-provider
  `*Client` layer, no shared base interface.
- Mixed-task embed batches are the workload rerankers exist for; we
  explicitly deferred them to `Reranker`.
- Multimodal rerank documents can reuse the `EmbedContentPart` union.

From [plans/v0-13.md](../v0-13.md): Jina is the launch provider
(`jina-reranker-v3`, `jina-reranker-m0`); strings-only documents
recommended for the common request; the open question is whether that
recommendation survives contact with the current provider landscape.

## Questions the research must answer

### Q1. Provider landscape, 2026 state

For each: current model generation, wire shape, auth, max documents
per call, max tokens per document, structured/multimodal document
support, pricing unit (per-search vs per-token), score semantics
(bounded [0,1]? calibrated?).

- **Existing providers first** (they land in packages we already
  ship): Jina (v3 / m0), Mistral, OpenAI, Google. Mistral and OpenAI
  need a real check: do they ship a dedicated rerank endpoint at all,
  or only embeddings + LLM-as-judge patterns? Google has semantic
  ranking in Vertex AI Search; establish whether it is reachable as a
  standalone API worth wrapping or gated behind the Search product.
- **Dedicated rerank vendors**: Cohere (rerank-v3.5+, and whatever
  v4-era exists), Voyage (rerank-2 family), Mixedbread
  (mxbai-rerank-v2). These validate the common interface even if none
  ships in v0.13.
- **Open/self-hosted**: BGE-reranker, Qwen-reranker via TEI or
  OpenAI-compatible gateways. Only to answer: does an
  OpenAI-compatible `/rerank` de-facto standard exist (the way
  `/v1/chat/completions` does), and should the core request be shaped
  to match it?

### Q2. The common interface

- Which fields are genuinely uniform across providers
  ([feedback: don't unify what isn't unified](../../plans/v0-13.md)):
  `query`, `documents`, `model`, `top_n`, `return_documents`? What is
  provider-typed (Cohere `rank_fields` structured documents, Jina
  multimodal, instruction-following rerankers' `instruction` field)?
- Score contract: can core promise anything about `relevance_score`
  beyond "higher is better", or do providers differ on range and
  calibration? This decides whether `RerankResult.score` gets
  documented semantics or a warning.
- Does anything push back on strings-only `documents` in the common
  request? Instruction-following rerankers (Qwen3-style) and
  multimodal (m0) are the candidates.
- Error surface: what does each provider do on over-long documents:
  truncate silently, reject, bill anyway? Maps to which `AiError`
  bucket.

### Q3. Is reranking still worth a capability?

The strategic question: is cross-encoder reranking being displaced by
agentic search (the model iterates queries and reads results itself,
no rerank stage) and by long-context stuffing?

- What do 2025-2026 RAG architecture writeups actually deploy? Is
  rerank still a standard stage in production pipelines, or legacy?
- Counter-signal to check: agentic search still needs candidate
  ranking per hop; rerankers are cheap (~10-50ms, fraction of LLM
  cost) versus an extra LLM call per filtering decision.
- Vendor investment as evidence: are Cohere/Jina/Voyage still
  shipping new reranker generations in 2025-2026, or has the product
  line gone quiet?
- Output: a go / no-go / reshape recommendation. "Reshape" would mean
  e.g. shipping rerank only as part of the retrieval recipe story
  rather than as a headline capability.

### Q4. In-repo fit (no web needed)

- Confirm the `EmbeddingModel` pattern transfers: `Context.Service`
  tag, `CommonRerankRequest`, module-level sugar, provider request
  extending common. Identify where rerank differs (no encoding axis,
  no batch-of-inputs axis; `documents` is the batch).
- Jina package: what `JinaClient` internals (`auth`, base URL, error
  mapping) does `JinaReranker.ts` reuse verbatim?
- Usage metrics: what does the rerank usage object look like per
  provider, and does core `Metrics` need a new counter kind?

## Method

1. Sweep in-repo sources first (Q4, plus the known-facts list above);
   nothing on the web can contradict what our own code constrains.
2. Web research per provider (Q1), primary docs only: API references,
   changelogs, pricing pages. No blog summaries for wire shapes.
3. Q2 falls out of Q1 as a comparison table; write it as
   uniform-vs-provider-typed, the same split `CommonEmbedRequest`
   used.
4. Q3 last, separate from the wire research: survey pieces, vendor
   release cadence, RAG architecture posts from 2025-2026. Keep
   opinions labeled as opinions.

## Deliverable

`plans/research/reranking.md` with: provider matrix (Q1), the
common-vs-typed field split with a concrete `CommonRerankRequest`
proposal (Q2), the strategic recommendation (Q3), and the in-repo
reuse notes (Q4). That document then feeds the design section of
[plans/v0-13.md](../v0-13.md) item 1, replacing its open question.

## Out of scope

- RAG recipe / hybrid retrieval research (v0-13 item 2/2b, second
  step, researched separately).
- Implementing anything.
- Vendors we would not plausibly wrap in the next two releases.
