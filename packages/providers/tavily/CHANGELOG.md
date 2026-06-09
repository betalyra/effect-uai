# @effect-uai/tavily

## 0.8.0

### Minor Changes

- 842d92b: New package: `@effect-uai/tavily`. A `WebSearch` provider backed by
  Tavily's search API. Registers both the generic `WebSearch` tag and the
  provider-typed `TavilySearch` tag. Returns `content` as the result snippet
  plus a relevance `score`, maps `includeDomains` / `excludeDomains`
  directly, and formats date ranges as `YYYY-MM-DD`. `recency` maps onto
  `time_range` (the `hour` granularity has no equivalent and is
  `warnDropped`); `country` and `language` are `warnDropped` (Tavily expects
  full names rather than ISO codes). Tune relevance via `TavilySearchDepth`
  and `TavilyTopic`.
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
