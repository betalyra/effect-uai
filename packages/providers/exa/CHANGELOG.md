# @effect-uai/exa

## 0.12.0

### Minor Changes

- 2ac62a9: Remove `@effect-uai/exa/ExaDeepResearch`. Exa retired the Research API
  (`POST /research/v0/tasks` now returns `RESEARCH_RETIRED`), so the capability
  could no longer succeed. The replacement (Exa's general Agent API) is a broader
  primitive than deep research and does not fit the `DeepResearch` capability; a
  dedicated managed-agent capability is tracked separately.

  `@effect-uai/exa/ExaSearch` and `@effect-uai/exa/ExaContents` are unaffected.
  For provider-hosted deep research, use `OpenAIDeepResearch`,
  `PerplexityDeepResearch`, or `GoogleDeepResearch`.

## 0.11.0

### Minor Changes

- 1efb6b4: New `DeepResearch` capability (additive). Submit a question, a provider runs a
  long-running background research job (many web searches over minutes), and you
  collect one cited report.
  - **`@effect-uai/core/DeepResearch`**: the generic `DeepResearch` tag and the
    portable accessors `research` (submit and poll to the terminal `Turn`),
    `researchStream` (submit and forward live `TurnEvent`s, terminating in
    `TurnComplete`), plus the detached trio `submit` / `status` / `collect` /
    `streamFrom` / `cancel`. A completed result is a plain `Turn` (project it with
    `Turn.assistantText` / `Turn.citations` / `Turn.decodeStructured`); the
    streaming terminal and the collected value are the same shape.
  - **`@effect-uai/core/Job`**: the generic background-job primitive the capability
    is built on. A `JobRef<A>` is serializable `{ _tag, provider, id }` data, so a
    job can be submitted now and collected from a later process. `Job.collect` /
    `Job.run` drive the poll-to-settle loop; `Job.JobConfig` tunes poll cadence
    (default 10s) and overall timeout (default 45m).
  - **`@effect-uai/core/Research`** and **`@effect-uai/core/Citation`**: the shared
    `ResearchRequest` and the provider-agnostic `Citation` / `Source` /
    `CitationSpan` model that normalizes how providers link answer text to sources
    (char span, quote, positional marker, or bare source).
  - Providers register the generic `DeepResearch` tag plus a provider-typed tag
    for the narrowed knobs: `@effect-uai/responses/OpenAIDeepResearch`
    (`o3-deep-research`, submit creates a streaming background job),
    `@effect-uai/google/GoogleDeepResearch` (Gemini Interactions, real streaming),
    `@effect-uai/perplexity/PerplexityDeepResearch` (`sonar-deep-research`,
    poll-only with a synthesized stream), and `@effect-uai/exa/ExaDeepResearch`
    (`exa-research`, poll-only, with a provider-typed `outputSchema` for
    structured output).

  Every provider is modeled as a job (`submit` / `poll` / `cancel`), so
  `fromJob(ops, config?)` derives the whole uniform surface once and an
  implementor states only its wire calls. See the
  [native deep research recipe](https://effect-uai.betalyra.com/recipes/native-deep-research/).

## 0.10.0

### Minor Changes

- 98ee12c: New `WebRead` capability (additive). Turn a URL into clean markdown or HTML,
  then extract typed data from it. It mirrors `WebSearch`: one generic tag,
  several provider layers, and a ready-made tool.
  - **`@effect-uai/core/WebRead`**: the generic `WebRead` tag and `read(request)`
    helper. A request is `{ url, format?, timeout? }`; a response is
    `{ url, content, title?, links?, raw }`. Every implementor answers `read`,
    so the capability needs no marker tags.
  - **`@effect-uai/core/WebReadTool`**: `webReadTool(options?)` hands the
    capability to a model as a tool, the same way `webSearchTool` does for
    search. `Output` is the rendered string; it fails with `AiError`.
  - Four providers register the generic `WebRead` tag, swappable as a Layer:
    `@effect-uai/firecrawl` (new package, JS-rendered pages),
    `@effect-uai/exa/ExaContents`, `@effect-uai/tavily/TavilyRead`, and
    `@effect-uai/jina/JinaReader`.

## 0.9.0

## 0.8.0

### Minor Changes

- 842d92b: New package: `@effect-uai/exa`. A `WebSearch` provider backed by Exa's
  search API. Registers both the generic `WebSearch` tag and the
  provider-typed `ExaSearch` tag. Translates `recency` into a computed
  `startPublishedDate`, maps `includeDomains` / `excludeDomains` onto Exa's
  domain filters, and exposes the provider-typed `ExaSearchType`
  (`auto` / `fast` / `neural` / `keyword` / ...) and `ExaCategory`.
  `language` is `warnDropped` (no wire field); Exa's `costDollars` is kept
  on the raw payload only (cost reporting is deferred to the upcoming
  usage-tracking pass).
- 842d92b: 0.8 adds web search. A new `WebSearch` capability lands in core: a generic
  service for "search the live web" that providers register against, a free
  `search` helper, and a `webSearchTool` you hand to the agent loop so the
  model can ground its answers in current results. Three search providers
  debut behind it (`@effect-uai/perplexity`, `@effect-uai/exa`,
  `@effect-uai/tavily`), and two recipes show the patterns end to end:
  [grounded answer](https://effect-uai.betalyra.com/recipes/grounded-answer/)
  (search, read, cite) and
  [deep research](https://effect-uai.betalyra.com/recipes/deep-research/)
  (plan, fan out parallel sub-agents, synthesize a cited report).

  Like the request shape on every other capability, `CommonSearchRequest`
  is the cross-provider intersection (`query`, `maxResults`, `recency`,
  date range, `includeDomains` / `excludeDomains`, `country`, `language`);
  each provider maps what it supports and `warnDropped`s the rest instead
  of silently changing your query. Cost reporting is deliberately left off
  `SearchResponse` for now, deferred to a unified usage-tracking pass.

  **Purely additive. No migration needed.** Bump dependencies, run
  typecheck, done. The new surface is in
  [Migrating to 0.8](https://effect-uai.betalyra.com/migrations/v0-8/).

  Every package outside core and the three new search providers
  (`@effect-uai/responses`, `@effect-uai/anthropic`, `@effect-uai/google`,
  `@effect-uai/jina`, `@effect-uai/openai`, `@effect-uai/elevenlabs`,
  `@effect-uai/inworld`, `@effect-uai/microsandbox`, `@effect-uai/deno`)
  has no functional changes this release; they bump for lockstep versioning
  only.
