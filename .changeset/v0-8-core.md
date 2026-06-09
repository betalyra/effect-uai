---
"@effect-uai/core": minor
---

New `WebSearch` capability (additive):

- **`@effect-uai/core/WebSearch`**: a generic `WebSearch` service for
  searching the live web, with a free `search` helper (resolve the tag,
  call `.search`). `CommonSearchRequest` is the cross-provider request
  intersection (`query`, `maxResults`, `recency`, `startDate` / `endDate`
  as `DateTime`, `includeDomains` / `excludeDomains`, `country`,
  `language`); `SearchResponse` carries normalized `SearchResult`s
  (`url`, `title`, `snippet`, `publishedDate`, `score`) plus the raw
  provider payload. `SearchRecency` is `"hour" | "day" | "week" | "month"
  | "year"`. A provider `layer` registers both the generic `WebSearch` tag
  and its provider-typed tag at once.
- **`@effect-uai/core/WebSearchTool`**: `webSearchTool(options?)` builds a
  ready-to-use tool for the agent loop. The model only chooses `query`
  (and optional `recency`); app policy (`maxResults`, `includeDomains` /
  `excludeDomains`, result rendering) lives in the constructor, not the
  model arguments. The tool annotates a `web_search` client span.

See [Migrating to 0.8](https://effect-uai.betalyra.com/migrations/v0-8/).
