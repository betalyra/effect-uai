# Research: reranking (v0.13 item 1)

Findings for the questions in
[reranking-plan.md](./reranking-plan.md). Web research from primary
sources (API references, changelogs, pricing pages), August 2026.
Claims a primary source could not confirm are flagged UNVERIFIED.

## Verdict up front

**GO, reshaped.** Reranking is alive and actively invested in: every
major vendor shipped a new generation within the last 14 months, and
new entrants keep appearing. The reshape: frame `Reranker` as a
candidate-filtering primitive an agent loop calls per hop, not as
"step 2 of the RAG pipeline", and keep it fully decoupled from
embeddings. For v0.13 the launch provider is Jina, whose wire shape is
also the de-facto ecosystem standard.

The prior forward-look in [embeddings.md](../embeddings.md) holds up
with one correction: Cohere's v2 API dropped `return_documents` and
`rank_fields` (both were v1 fields), so the four-provider convergence
is now on an even smaller common core than we assumed.

## Q1. Provider landscape, August 2026

### Our existing providers

Only one of the four has anything to wrap:

| Provider | Rerank API? | Notes                                                                                                                                                                                                                                                                              |
| -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jina     | Yes, full   | The launch provider, details below.                                                                                                                                                                                                                                                |
| Mistral  | No          | Full docs.mistral.ai surface checked: embeddings and managed Beta RAG indexes, no rerank endpoint, none in the SDK.                                                                                                                                                                |
| OpenAI   | No          | No rerank endpoint anywhere; `file_search` reranks internally but it is not addressable.                                                                                                                                                                                           |
| Google   | GCP-gated   | Discovery Engine Ranking API (`semantic-ranker-default-004`): real, cheap ($1/1K queries, 100 docs each), documented [0,1] scores, but needs a GCP project + OAuth, not an API key. Nothing rerank-shaped on the Gemini API (checked the v1beta discovery doc: zero rank methods). |

**Jina** (`POST https://api.jina.ai/v1/rerank`, Bearer auth):

- Request: `model`, `query`, `documents`, `top_n?`, `return_documents?`.
  Text models take `documents: string[]`; `jina-reranker-m0` takes
  objects `{text}` or `{image}` (image queries are NOT supported over
  the API, only local inference).
- Response: `{ model, usage: { total_tokens }, results: [{ index, relevance_score, document? }] }`.
- Models: `jina-reranker-v3.5` (July 2026 flagship: 0.6B listwise,
  131K token context, 93 languages, schema-identical drop-in for v3;
  adds `return_embeddings?`), `jina-reranker-v3` (Oct 2025),
  `jina-reranker-m0` (Apr 2025, still the only multimodal option, no
  successor), legacy `jina-reranker-v2-base-multilingual`.
- Limits: no hard max-documents cap (API batches internally by
  tokens); ~64 docs per listwise forward pass inside the 131K window.
- Scores: floats, observed in (0,1), higher is better. Range and
  calibration are NOT documented, and listwise scoring makes scores
  context-dependent across the candidate set.
- Pricing: token-based against the shared Jina token wallet, billed on
  `usage.total_tokens`.

### Dedicated vendors (validate the interface, not v0.13 targets)

- **Cohere Rerank 4.0** (Dec 2025): `rerank-v4.0-pro` / `-fast`, 32K
  context, JSON/semi-structured documents. `POST /v2/rerank` request:
  `model`, `query`, `documents: string[]`, `top_n?`,
  `max_tokens_per_doc?` (default 4096, auto-truncates), `priority?`.
  v2 dropped v1's `return_documents` and `rank_fields`: strings only,
  no document echo. Response scores documented normalized [0,1].
  Pricing per search unit (1 query + up to 100 docs).
- **Voyage rerank-2.5 / 2.5-lite** (Aug 2025, now MongoDB; standalone
  API still offered): first instruction-following rerankers, but the
  instruction travels inside the query text, there is no separate
  field. `POST /v1/rerank`: `query`, `documents` (max 1,000), `model`,
  `top_k?` (note: not `top_n`), `return_documents?`, `truncation?`.
  Response mirrors OpenAI list style with `usage.total_tokens`.
  Token-based pricing ($0.05/M, lite $0.02/M).
- **Mixedbread**: pivoted to managed "Stores"; standalone
  `POST /v1/reranking` still exists (`model`, `query`, `input`,
  `top_k?`, `rank_fields?`, `return_input?`; PARTIALLY VERIFIED).
  Models through `mxbai-rerank-v3.1-listwise` (2026). Pricing is now
  an add-on to their search product, no clean per-token price.
- **New entrants 2025-2026**: Qwen3-Reranker (June 2025, open,
  0.6B/4B/8B, hosted on Alibaba Cloud/DeepInfra), Contextual AI
  (`ctxl-rerank-v2-instruct-multilingual`, the one vendor with an
  explicit `instruction` request field), ZeroEntropy (zerank-1/2,
  acquired by Notion, API sunsets Sept 2026: a dead end).

### De-facto standard: yes, and it matters

The Cohere/Jina shape
`{ model, query, documents, top_n } → { results: [{ index, relevance_score }] }`
is the de-facto standard:

- **vLLM** exposes `/rerank`, `/v1/rerank`, `/v2/rerank` and documents
  itself as implementing Jina's v1 API and being Cohere v1/v2
  compatible. Self-hosted rerankers (Qwen3, bge, mxbai) speak it out
  of the box.
- **OpenRouter now proxies rerank** (`POST /api/v1/rerank`,
  Cohere-style, listing `cohere/rerank-4-pro`, `voyageai/rerank-2.5`).
  The strongest signal the shape is the gateway standard, and a future
  cheap win: one adapter targeting this shape reaches Cohere and
  Voyage through the gateway without provider packages.
- Divergent shapes exist but are minor players: HF TEI uses
  `texts`/`score`, NVIDIA NIM uses `passages` and returns raw
  `logit`s.

## Q2. The common interface

What is genuinely uniform across Jina, Cohere v2, Voyage, Mixedbread,
OpenRouter, and vLLM:

```ts
type CommonRerankRequest = {
  readonly query: string
  readonly documents: ReadonlyArray<string>
  readonly model: string
  readonly topN?: number
}

type RerankResult = {
  readonly index: number // position in the request's documents
  readonly score: number // higher is better; range NOT promised
}

type RerankResponse = {
  readonly results: ReadonlyArray<RerankResult> // descending by score
  readonly usage: Usage // { totalTokens? }, absent for per-search-billed providers
}
```

Decisions this research settles:

- **Strings-only `documents` in the common request: confirmed.**
  Cohere v2 went strings-only; multimodal documents are Jina-m0-only
  (objects), structured documents are Cohere-v1/Mixedbread residue.
  Both are provider-typed widenings, exactly like `JinaEncoding`
  widens `EmbedEncoding`.
- **No `return_documents` in the common request.** Cohere v2 cannot
  echo documents at all, and in a typed library the caller already
  holds the `documents` array; `results[].index` is sufficient. Echo
  saves nothing and breaks on one major provider. Per
  don't-unify-what-isn't-unified, leave it off everywhere (a provider
  request can add it if someone asks).
- **`topN` is common.** Voyage spells it `top_k`, Mixedbread `top_k`,
  Cohere/Jina/OpenRouter `top_n`; the semantics are identical. Map per
  wire.
- **Score contract: "higher is better, results sorted descending" and
  nothing more.** Google documents [0,1]; Cohere documents normalized
  [0,1]; Jina doesn't document a range and its listwise scores are
  candidate-set-dependent; NIM returns raw logits. Core must not
  promise a range or cross-request comparability. Document this
  explicitly: scores order candidates within one call, they are not
  calibrated probabilities.
- **`instruction` stays provider-typed.** Only Contextual has a real
  field; Voyage/Mixedbread take instructions as natural language in
  the query, which needs no API surface at all.
- **Truncation is provider-typed.** Cohere `max_tokens_per_doc`
  auto-truncates, Voyage `truncation: boolean`, Google truncates
  silently, Jina batches internally. No uniform knob exists; document
  per provider what happens to over-long documents.

## Q3. Still worth a capability?

**Yes.** Evidence:

- **Vendor cadence is accelerating, not quiet**: Cohere Rerank 4 (Dec
  2025), Jina v3 then v3.5 (two generations in 10 months, latest July
  2026), Voyage 2.5 (Aug 2025), Mixedbread v3.1-listwise (2026), plus
  Qwen3, Contextual, ZeroEntropy entering 2025-2026. MongoDB acquiring
  Voyage and Notion acquiring ZeroEntropy are platform bets on the
  category.
- **Production 2025-2026 writeups** still deploy two-stage retrieval
  as the default: hybrid retrieval to top-50, cross-encoder to top-5,
  with reranking called the largest single quality jump available
  without changing the base model. Elastic, Weaviate, MongoDB,
  Pinecone integrate rerankers natively.
- **The economics survive agentic search**: a rerank call is
  $0.001-0.0025 and 100-300ms per ~100 candidates versus an LLM call
  at 10-100x the cost reading the same candidates. Deep-research
  literature (2026) is adding rerankers per hop, not removing them.
- **The one genuine displacement is local code search**: Claude Code
  dropped vector retrieval for grep-and-iterate (May 2025), and an
  AAAI 2026 Amazon paper backs agentic keyword search reaching ~90-94%
  of RAG faithfulness. That is a niche where exact search is free;
  it does not generalize to web/document/enterprise retrieval
  (Cursor went the opposite way and trained a retrieval model).
- **Long-context stuffing loses on cost and on context rot** (accuracy
  degrades past ~60K tokens on every model tested in the pieces
  surveyed; ~$3/query at 1M tokens vs fractions of a cent for
  retrieve+rerank).

The reshape consequence for docs and API: position `Reranker` as a
filtering primitive composable into loops and tools (per search hop),
not as a pipeline stage bolted to embeddings. Interface-wise the
listwise/instruction trend costs us nothing today: listwise is a
provider implementation detail behind the same wire shape, and
instructions ride in the query string.

## Q4. In-repo fit

- **The "shared per-provider `*Client` layer" from embeddings.md does
  not exist in the jina package.** `JinaEmbedding.ts` and
  `JinaReader.ts` are each self-contained: own `{ apiKey: Redacted,
baseUrl? }` config, own base URL default (`api.jina.ai/v1` vs
  `r.jina.ai`), duplicated `httpStatusError` table. `JinaReranker.ts`
  follows the same copy-per-surface pattern on `api.jina.ai/v1`.
  Extracting a shared client is out of scope for this change.
- **Pattern transfer from `EmbeddingModel` is direct**: tag as
  `Context.Service` under `@betalyra/effect-uai/Reranker`, common
  request in core, module-level `rerank(request)` sugar, provider
  request narrowing `model` to a typed union in `models.ts`. Simpler
  than embeddings: no encoding axis, no separate single/batch pair
  (`documents` is the batch).
- **Usage**: Jina and Voyage return `usage.total_tokens`; Cohere bills
  per search unit (`meta.billed_units.search_units`); Google per
  query. Core `Embedding.Usage` is `{ inputTokens? }`; a rerank
  `Usage` of `{ totalTokens? }` with everything optional covers all
  four. No new Metrics counter kind needed for v1.
- **Error mapping**: reuse the `httpStatusError` table shape from
  `JinaEmbedding.ts` verbatim (429 RateLimited, 401/403/402
  AuthFailed subtypes, 413 ContextLengthExceeded, 5xx Unavailable,
  else InvalidRequest).
- **Model union**: `JinaRerankerModel = "jina-reranker-v3.5" |
"jina-reranker-v3" | "jina-reranker-m0" | (string & {})` in
  `models.ts`, same open-union idiom as the embedding models. Default
  recipe/docs model: `jina-reranker-v3.5`.

## Consequences for plans/v0-13.md item 1

- Launch models: `jina-reranker-v3.5` (flagship, not v3 as the plan
  says) with v3 and m0 in the union.
- The open question (strings-only documents) is resolved: yes,
  strings-only in common, multimodal is a Jina-typed widening.
- Add to the response contract: results sorted descending, score range
  deliberately unpromised.
- Docs framing: per-hop filtering primitive for agent loops, not a
  pipeline stage.
- Future cheap win worth a line in the plan: an OpenRouter-shaped
  rerank adapter would reach Cohere and Voyage through the gateway,
  the same play as chat-completions.
