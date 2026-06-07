# Web search capability — design plan

Status: draft / for discussion. Adds a `WebSearch` capability to
effect-uai covering Perplexity, Exa, You.com, Tavily, and Brave.

## 1. Scope

**In scope: pure search only.** Query in, ranked web results out. This
is the one operation all five providers share, so it needs no capability
markers: every provider Layer can do it.

**Out of scope (noted, not built):**
- **extract / crawl** (Exa `/contents`, Tavily `/extract` + `/crawl` +
  `/map`, You.com `/contents`) — a plausible future addition; the design
  leaves room for it (section 8) but builds nothing now.
- **answer synthesis** (Perplexity Sonar, Tavily `include_answer`, Brave
  summarizer, etc.) — irrelevant for now.
- **findSimilar** (Exa) — irrelevant for now.
- **deep research** (Perplexity deep-research, Exa `/research`, You.com
  Research) — irrelevant for now.

## 2. Goal

A portable `WebSearch` capability shaped like `EmbeddingModel`,
`Transcriber`, and `MusicGenerator`: one generic service tag in
`@effect-uai/core`, a thin free-standing `search(...)` helper, and one
provider package per API surface that registers both the generic tag and
a provider-typed tag (the `EmbeddingModel` + `JinaEmbedding` pattern).

Search is a retrieval-class capability and sits next to the planned
`Reranker` (see [docs/reranking/index.md](../docs/reranking/index.md)).
The pipeline it feeds is **search -> rerank -> ground an LLM turn**, so
the result shape should compose with `Reranker` and `LanguageModel`
tool-calling.

## 3. The one operation, five wire shapes

All five do "query -> ranked results," but the result shapes differ:

| Provider | Endpoint | Transport | Per-result text field(s) | Score? |
| -------- | -------- | --------- | ------------------------ | :----: |
| Perplexity | `POST /search` | Bearer, JSON | `snippet` | — |
| Exa | `POST /search` | `x-api-key`, JSON | `text` / `highlights` / `summary` | ✓ 0..1 |
| You.com | `GET /v1/search` | `X-API-Key`, query | `snippets[]` (multi-chunk) | — |
| Tavily | `POST /search` | Bearer, JSON | `content` (+ `raw_content`) | ✓ |
| Brave | `GET /res/v1/web/search` | `X-Subscription-Token`, query | `description` (+ `extra_snippets`) | — |

The job of the core type is to normalize these into one `SearchResult`
while keeping the provider blob on `raw`.

## 4. Core types

Location: `packages/core/src/web-search/WebSearch.ts`, exported as
`@effect-uai/core/WebSearch`. Tag identifier
`@betalyra/effect-uai/WebSearch` (the npm scope is `@effect-uai`; the tag
string scope is `@betalyra/effect-uai`, matching every existing tag).

### Service + helper

No markers — `search` is universal.

```ts
export type WebSearchService = {
  readonly search: (request: CommonSearchRequest) => Effect.Effect<SearchResponse, AiError.AiError>
}

export class WebSearch extends Context.Service<WebSearch, WebSearchService>()(
  "@betalyra/effect-uai/WebSearch",
) {}

export const search = (
  request: CommonSearchRequest,
): Effect.Effect<SearchResponse, AiError.AiError, WebSearch> =>
  Effect.flatMap(WebSearch.asEffect(), (s) => s.search(request))
```

### Request: `CommonSearchRequest`

The rule: a field earns a place in the common request only if **most of
the five** support it (3+/5) and a developer would expect it from a
generic search interface. Everything else lives on the provider-typed
request (section 6). Support matrix:

| Field | PPLX | Exa | You | Tavily | Brave | Common? |
| ----- | :--: | :-: | :-: | :----: | :---: | :-----: |
| `query` | ✓ | ✓ | ✓ | ✓ | ✓ | **yes** |
| `maxResults` | ✓ | ✓ | ✓ | ✓ | ✓ | **yes** |
| `includeDomains` | ✓ | ✓ | ✓ | ✓ | via `q` | **yes** |
| `excludeDomains` | ✓ | ✓ | ✓ | ✓ | via `q` | **yes** |
| `startDate`/`endDate` | ✓ | ✓ | ✓ | ✓ | ✓ | **yes** |
| `recency` (enum) | ✓ | from dates | ✓ | ✓ | ✓ | **yes** |
| `country` | ✓ | approx | ✓ | ✓ | ✓ | **yes** (4/5) |
| `language` | ✓ | — | ✓ | — | ✓ | **yes** (3/5) |
| `safeSearch` | — | — | ✓ | enterprise | ✓ | no -> typed |
| `topic` (news/finance) | — | `category` | partial | ✓ | vertical | no -> typed |
| `offset`/pagination | — | request 100 | `offset` 0-9 | — | `offset` 0-9 | no -> typed |
| `model` | — | — | — | — | — | **no** |

The non-obvious cut is **`model`**: unlike every other capability, pure
search has no model to pick. None of the five `/search` endpoints take
one. What looks model-shaped (Exa `type`, Tavily `searchDepth`,
Perplexity `searchContextSize`) is a provider-specific mode knob, so it
belongs on the provider-typed request, not the common floor. Dropping
`model` is the honest call even though it breaks parallel with
`EmbeddingModel`/`Transcriber`.

```ts
export type CommonSearchRequest = {
  readonly query: string
  readonly maxResults?: number // PPLX/Tavily/Brave cap 20, Exa/You cap 100
  readonly includeDomains?: ReadonlyArray<string>
  readonly excludeDomains?: ReadonlyArray<string>
  readonly recency?: SearchRecency // convenience enum: hour|day|week|month|year
  readonly startDate?: DateTime.DateTime // published-after (precise alternative to recency)
  readonly endDate?: DateTime.DateTime // published-before
  readonly country?: string // ISO alpha-2
  readonly language?: string // ISO 639-1
}
```

`recency` and `startDate`/`endDate` are both kept because most providers
expose both a convenience enum and an explicit range; `recency` is sugar
that maps onto the date range where a provider has no enum (Exa).

**No common pagination.** Only Brave and You.com paginate, and only
shallowly (`offset` 0-9). Exa replaces paging by letting you request up
to 100 results in one call; Perplexity and Tavily cap at ~20 with no
offset. That is 2/5, and a portable `cursor`/`page` field would fake a
capability three providers lack. So pagination stays off the common
request and lives on `BraveSearch`/`YouSearch` as `offset`. The common
floor is "ask for `maxResults` in one call," which all five honor.

### Response: `SearchResponse` + `SearchResult`

Same rule for the result: a field stays on the common record only if
most providers return it. Support matrix:

| Field | PPLX | Exa | You | Tavily | Brave | Common? |
| ----- | :--: | :-: | :-: | :----: | :---: | :-----: |
| `url` | ✓ | ✓ | ✓ | ✓ | ✓ | **yes** |
| `title` | ✓ | ✓ | ✓ | ✓ | ✓ | **yes** |
| `snippet` | ✓ | text/hl | `description` | `content` | `description` | **yes** |
| `publishedDate` | ✓ | ✓ | `page_age` | news only | `page_age` | **yes** (4/5) |
| `score` | — | ✓ | — | ✓ | — | **optional** (2/5) |
| `snippets[]` (multi-chunk) | — | highlights | ✓ | — | `extra_snippets` | no -> typed |
| `author` | — | ✓ | ✓ | — | `profile` | no -> typed |
| `favicon` | — | ✓ | ✓ | ✓ | partial | no -> typed |

```ts
export type SearchResult = {
  readonly url: string
  readonly title?: string
  readonly snippet?: string // primary short excerpt; the one text field all five return
  readonly publishedDate?: DateTime.DateTime
  readonly score?: number // relevance 0..1; only providers that rank (Exa, Tavily), else undefined
  readonly raw: unknown // provider-native result object, never lossy
}

export type SearchResponse = {
  readonly results: ReadonlyArray<SearchResult>
  readonly usage?: SearchUsage // credits / cost when the provider reports it
  readonly raw: unknown
}
```

Decisions baked in:
- **`snippets[]` dropped from common.** Only You.com makes the per-hit
  multi-chunk array first-class (Brave's `extra_snippets` is
  supplementary, Exa's `highlights` is extract-adjacent). A single
  `snippet` is the honest common denominator; the multi-chunk array lives
  on `YouSearch`. This resolves the old "snippet vs snippets" open
  question.
- **`author` and `favicon` dropped to provider-typed.** 2/5 and 3/5
  respectively, and neither is something a developer expects from a
  *generic* web-search result (they read as article/display metadata).
- **`score` kept as optional despite only 2/5.** It earns its place by
  semantic value, not headcount: relevance ranking is core to what
  "search result" means, and optionality cleanly represents "this
  provider doesn't rank." Keeping it lets a caller rank Exa/Tavily
  results portably.
- **`text` / `highlights` / `summary` stay off** — they belong to the
  out-of-scope extract feature. Exa's inline `text` surfaces on
  `ExaSearch` only.

Open question for review: flat record vs tagged union. The five
providers differ by *which fields are present*, not by *kind*, so a flat
record with optionals fits better than a discriminated union (which
would force a synthetic discriminant nobody queries). Keep it flat unless
review disagrees.

## 5. Provider matrix

| Provider | npm package | typed tag | generic `WebSearch` |
| -------- | ----------- | --------- | :-----------------: |
| Exa | `@effect-uai/exa` | `ExaSearch` | ✓ |
| Perplexity | `@effect-uai/perplexity` | `PerplexitySearch` | ✓ |
| You.com | `@effect-uai/you` | `YouSearch` | ✓ |
| Tavily | `@effect-uai/tavily` | `TavilySearch` | ✓ |
| Brave | `@effect-uai/brave` | `BraveSearch` | ✓ |

All five register the generic tag (no markers). One package per API
surface (memory: packages scope to one API surface).

## 6. Provider-typed surfaces

Each typed tag widens `model` and exposes the provider's own search
knobs, exactly like `JinaEmbedding` widens `task`/`encoding` over
`EmbeddingModel`. Search-only knobs:

- **`ExaSearch`**: `type` (neural/keyword/auto/fast), `category`
  (research paper/github/company/news/pdf/...), `numResults` up to 100.
  Result-side: `author`, `favicon`. Exa is the only provider exposing
  semantic-vs-keyword as a request knob; it stays provider-typed, silent
  on the generic surface.
- **`PerplexitySearch`**: batch `query` array on `/search`,
  `searchContextSize` (low/medium/high).
- **`BraveSearch`**: `safeSearch`, `offset` (0-9 pagination), `goggles`
  re-ranking rule sets, `freshness` codes, `extraSnippets`, the `web`
  vertical result fields (`page_age`, `profile`). Brave's other verticals
  (news/videos/infobox/discussions) are out of scope for the pure-search
  cut.
- **`TavilySearch`**: `searchDepth` (basic/advanced/fast), `topic`
  (general/news/finance), `chunksPerSource`. Result-side: `favicon`.
- **`YouSearch`**: `safeSearch`, `offset` (0-9 pagination), `boostDomains`
  (up to 500), the per-hit `snippets[]` (their signature RAG field),
  `author`, `favicon`. Note the host split: search lives on
  `ydc-index.io`.

The fields demoted from the common types (section 4) — `safeSearch`,
`topic`, `offset`, `snippets[]`, `author`, `favicon` — land here on
whichever typed surfaces actually support them. They are reachable when you hold the
typed tag; they just are not promised by the portable `WebSearch`
contract.

## 7. Capability-honesty mapping (search fields)

Apply the existing three-bucket floor (shape mismatch -> `Unsupported`;
unstructured hint dropped -> `Capabilities.warnDropped`; natively
interpreted but off-generic-surface -> silent / provider-typed). The
non-obvious cases:

- **Brave domain filtering is a shape transform, not a drop.** Brave has
  no `includeDomains`/`excludeDomains` fields; it takes `site:` operators
  inside `q`. The adapter compiles `includeDomains`/`excludeDomains` into
  the query string. Lossless, so do it silently; document it.
- **`recency` maps to provider enums** — all lossless. Perplexity
  `search_recency_filter`, Brave `freshness` (pd/pw/pm/py), Tavily
  `time_range`, You.com `freshness`. Exa has no recency enum, so map
  `recency` to a computed `startPublishedDate` (ISO range).
- **`startDate`/`endDate`**: native on Exa (published-date range) and
  Perplexity (`search_after/before_date_filter`, `MM/DD/YYYY`), Tavily
  (`start_date`/`end_date`), Brave (custom `freshness` range), You.com
  (date-range `freshness`). Format-translate per provider.
- **`country` / `language`** (common fields): native on most; where a
  provider lacks one, `warnDropped`.
- **Provider-only knobs** (Exa `type`, Brave `goggles`/`safeSearch`,
  Tavily `searchDepth`/`topic`, You `safeSearch`): silent, provider-typed
  request only — they never reach the common surface, so there is nothing
  to drop or warn about.

## 8. Leaving room for extract (future, not built)

Do not paint the design into a corner. When extract/crawl lands later it
should slot in as either (a) a second method `extract` on `WebSearchService`
gated by a `ContentExtraction` marker (the `SttStreaming` pattern), or
(b) its own `ContentFetcher` capability. Either way the current
`SearchResult` stays as-is and gains `text`/`highlights`/`summary` only
through that future path. Nothing in the search types blocks this.

## 9. Errors

Reuse `AiError` from
[packages/core/src/domain/AiError.ts](../packages/core/src/domain/AiError.ts)
unchanged:
- 401/403 -> `AuthFailed`
- 429 -> `RateLimited` (Brave's low-QPS tiers make this common; honor
  `Retry-After`)
- 400 / bad params -> `InvalidRequest`
- transport / decode -> `Unavailable` / `Timeout`

No new error variants needed.

## 10. Package layout & versioning

New packages, all in the `fixed` changeset group, debuting at the current
group version (memory: new fixed-group packages start at the current
version, currently 0.7.0, not 0.0.0):

```
packages/core/src/web-search/WebSearch.ts   -> @effect-uai/core/WebSearch
packages/providers/exa/                     -> @effect-uai/exa
packages/providers/perplexity/              -> @effect-uai/perplexity
packages/providers/brave/                   -> @effect-uai/brave
packages/providers/tavily/                  -> @effect-uai/tavily
packages/providers/you/                     -> @effect-uai/you
```

Each provider package mirrors the Jina layout: `package.json` with `.` +
`./{Provider}Search` exports, `src/index.ts` re-exporting the namespace,
`src/models.ts` for the model/mode literals, peer deps on
`@effect-uai/core` and `effect@4.0.0-beta.57`. Add `"./WebSearch"` to the
core package exports map. All bumped together (fixed group) -> one
umbrella `minor` changeset.

## 11. Phasing

1. **Phase 1 — core + tool + two providers.** Land `WebSearch` (just
   `search`) and the `webSearchTool` factory (section 12), then **Exa**
   (richest knobs, the reference) and **Tavily** (simplest wire). Ship the
   two flagship recipes (section 13).
2. **Phase 2 — breadth.** Add **Brave** (domain-filter compile into `q`),
   **Perplexity** (Sonar/search models), **You.com** (snippets + host
   split), and the `fact-check` recipe (section 13).
3. **Phase 3 — depth.** The `deep-research` recipe (a long-running
   iterative search agent, section 13), and once `Reranker` lands a
   search -> rerank -> grounded-turn recipe showing the full retrieval
   pipeline.

## 12. The LLM tool — ship one

Search's dominant use is grounding an LLM. Today every user would
re-write the same glue: declare a tool with a `query` param, call
`search`, render results into text the model can read. effect-uai already
has the tool machinery to make this a one-liner
([packages/core/src/tool/Tool.ts](../packages/core/src/tool/Tool.ts)):
`Tool.make<Name, Input, Output, R>` carries an `R` requirement on its
`run`, and `Tool.execute` runs it inside whatever services are provided.
So a search tool's `R` is just `WebSearch` — providing any search
provider Layer satisfies it.

**Recommendation: yes, ship a canonical `webSearchTool` factory** in
`@effect-uai/core` (export `@effect-uai/core/WebSearchTool`). Sketch:

```ts
// R = WebSearch — the tool needs a search provider in scope, nothing else
export const webSearchTool = (options?: {
  readonly name?: string // default "web_search"
  readonly maxResults?: number // app-fixed cost ceiling; not model-controlled
  readonly render?: (results: ReadonlyArray<SearchResult>) => string
}): Tool.Tool<"web_search", WebSearchToolArgs, string, WebSearch> =>
  Tool.make({
    name: options?.name ?? "web_search",
    description: "Search the web for current information. Returns ranked results with titles, URLs, and snippets.",
    inputSchema: Tool.fromEffectSchema(
      Schema.Struct({
        query: Schema.String,
        // the important filters, exposed to the model from day one
        recency: Schema.optional(SearchRecencySchema), // hour|day|week|month|year
        includeDomains: Schema.optional(Schema.Array(Schema.String)),
        excludeDomains: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    run: (args) =>
      search({ ...args, maxResults: options?.maxResults ?? 5 }).pipe(
        Effect.map((r) => (options?.render ?? defaultRender)(r.results)),
      ),
  })
```

This is the payoff of the portable design: **the model-facing tool
contract is identical no matter which search backend answers.** Swap
`BraveSearch.layer` for `ExaSearch.layer` and the LLM's tool schema,
name, and description do not change. It also composes with the existing
`Toolkit` and `LanguageModel` tool-calling loop with no new machinery.

Design choices for the tool (distinct from the raw capability):
- **Model-facing schema exposes the important filters from day one:**
  `query` plus `recency`, `includeDomains`, `excludeDomains`. A capable
  model uses these to scope a search itself ("search X from the past
  week", "only on docs.foo.com"), which is exactly the agentic behavior
  the tool exists to enable. `maxResults` stays an app-set cost ceiling,
  not a model knob. (`country`/`language` are left off the tool schema as
  niche; they remain available on the raw `search` call.)
- **`Output` is rendered text, not raw `SearchResult[]`.** The model
  reads a numbered list (title, url, snippet). Provide a `render`
  override for callers who want JSON or a different format. The structured
  results remain available to the app through the normal turn/tool-result
  channel.
- **Layer on top of the generic `WebSearch` tag**, never a provider tag,
  so the tool stays backend-agnostic.

What we are *not* doing: wrapping provider-native server-side search
tools (Anthropic web search, OpenAI web search, Gemini grounding). Those
are a different feature — the LLM provider doing its own search. Our tool
routes through our `WebSearch` providers regardless of the LLM, which is
the portable, provider-mixing story. A native-tool passthrough could be a
separate later addition.

## 13. Recipes

Following the existing two-tier pattern (`basic-*` one-concept files vs
named-scenario combinators). Four recipes, increasing in ambition:
`basic-search` (no LLM) -> `grounded-answer` (single-shot tool use) ->
`fact-check` (deterministic fan-out) -> `deep-research` (long-running
iterative agent). The first two ship in Phase 1; `fact-check` and
`deep-research` follow in Phases 2-3.

### `basic-search` (basic)

Parallel to [basic-embedding](../recipes/basic-embedding/README.md).
Query in, ranked results out, with a `--provider` switch across all five
backends. The program body is provider-agnostic; only the Layer at the
bottom changes. Search's own twist over the embedding recipe: print two
providers' top-5 side by side so the reader *sees* that neural (Exa) vs
keyword vs independent-index (Brave) backends genuinely disagree on the
same query. This is the smallest end-to-end shape and the place to
introduce `CommonSearchRequest` / `SearchResult`.

### `grounded-answer` (flagship)

A `LanguageModel` agentic loop that answers a current-events question by
calling `webSearchTool` (section 12), then writes an answer with inline
citations. Reuses the [agentic-loop](../recipes/agentic-loop/) +
tool-calling machinery, so it is mostly wiring, not new concepts. The
headline demo is **portability on two axes at once**: swap the LLM Layer
(Anthropic / Gemini / OpenAI) and the search Layer (Brave / Exa)
independently, and neither the program nor the model-facing tool contract
changes. This is the recipe that justifies the whole capability, since
LLM grounding is the dominant use of web search.

### `deep-research` (advanced, Phase 3)

A long-running research agent built from the `search` primitive: it
plans sub-questions, searches the web in a loop, reads results, notices
gaps, searches again, and finally synthesizes a structured,
citation-backed report. Where `grounded-answer` is single-shot Q&A, this
runs many search -> read -> reflect iterations until it has enough to
answer a broad question ("compare the current state of X across vendors",
"what changed in Y this quarter").

This is the deliberate from-scratch counterpart to the providers' native
deep-research endpoints (Perplexity deep-research, Exa `/research`,
You.com Research) that section 1 leaves out of the capability. The point
of building it from our own `search` is exactly that it is **not** a
provider black box: the same loop works against any search backend and
any LLM, and every step (which sub-query, which sources, why it kept
going) is visible and controllable. That is the library's value over
calling one vendor's opaque `/research` call.

It composes three existing recipes:
- [agentic-loop](../recipes/agentic-loop/) for the search -> reflect loop
  driving `webSearchTool` (section 12).
- [auto-compaction](../recipes/auto-compaction/) because a long research
  run accumulates many results and outgrows the context window; this is
  the natural showcase for compaction under real pressure.
- [structured-output](../recipes/structured-output/) to emit the final
  report (sections, findings, sources) as a typed object rather than free
  text.

Stop conditions matter: cap iterations / token budget / wall-clock so the
agent terminates. Worth noting in the recipe as the practical difference
between a research agent and a runaway loop.

### `fact-check` (verification agent, Phase 2)

A self-verification guardrail: take an answer (model-generated or
supplied), decompose it into atomic claims, search the web to verify each
one in parallel, and emit a typed report labeling every claim
`supported` / `refuted` / `unverified` with the source that settled it.
Hallucination guardrails are table stakes in production, and there is no
clean reference for "ground the model's own output."

The architectural contrast with `grounded-answer` is the point:
`fact-check` is **deterministic orchestration, not an agentic tool loop.**
We drive the searches (one per claim) instead of handing the model a tool
and hoping it calls it the right number of times. That makes it cheaper,
reproducible, and it is the one recipe whose star is Effect's structured
concurrency rather than tool-calling.

Pipeline: produce/accept the answer -> structured turn extracts
`Claim[]` (each with its own search query, opinions dropped) ->
`Effect.all(claims.map(verifyClaim), { concurrency })` runs one
`search` + one structured verdict turn per claim -> aggregate into a
`Report` with a trust score. Requirement is just `LanguageModel |
WebSearch`; provide e.g. `Anthropic.layer` + `BraveSearch.layer`.

Design points worth writing down:
- **`Effect.all({ concurrency })`** is the centerpiece, capped for
  search-provider QPS (Brave's tiers are low), with `AiError.RateLimited`
  handled at the layer.
- **Evidence is forced**: `supported`/`refuted` must carry a `quote` +
  `url`; the search results are the only allowed grounding, so the judge
  cannot re-hallucinate.
- **`unverified` is first-class**, not a binary. "Couldn't confirm" is
  the honest real-world outcome when search comes up short.
- **Typed `Report` out**, so the recipe doubles as a guardrail you can
  gate on (fail CI when `trustScore` falls below a threshold) rather than
  a toy. Leans on [structured-output](../recipes/structured-output/).
- Deliberately does **not** use `webSearchTool` (section 12) - the
  contrast with `grounded-answer`. Optional flourishes: stream verdicts
  live off the fan-out, and a step-5 self-revision pass that rewrites the
  answer dropping refuted claims.

(Considered and dropped: a `search-council` that fans one query to all
five providers to compare results. The multi-provider compare works for
LLMs, where people genuinely A/B model quality, but not for search: users
pick one search backend and commit, so the recipe answers a
library-marketing question, not a real workflow.)

## 14. Resolved decisions

1. **Tag name = `WebSearch`.** Reads well as `WebSearch.search(...)`, no
   global/keyword collision.
2. **`SearchResult` is a flat record with optionals**, not a tagged
   union — the providers differ by field-presence, not kind.
3. **No common pagination** (section 4). 2/5 support it and only
   shallowly; `offset` is provider-typed on `BraveSearch`/`YouSearch`.
4. **The tool exposes the important filters from day one** (section 12):
   `query` + `recency` + `includeDomains`/`excludeDomains`. `maxResults`
   stays an app-set ceiling.

## 15. Relationship to existing surface

- **Reranking** ([docs/reranking/index.md](../docs/reranking/index.md)):
  search returns candidates; `Reranker` reorders them. Keep
  `SearchResult.score` so a caller can skip reranking when the provider's
  own score is good enough.
- **LanguageModel tool-calling**: the shipped `webSearchTool`
  (section 12) is the canonical backing; its `R` is `WebSearch`, so it
  drops into a `Toolkit` and a turn with no extra wiring.
- **EmbeddingModel**: Exa's neural mode is embeddings-backed search; a
  caller could also embed result snippets for a local vector index. The
  shapes compose.
