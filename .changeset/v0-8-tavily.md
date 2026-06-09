---
"@effect-uai/tavily": minor
---

New package: `@effect-uai/tavily`. A `WebSearch` provider backed by
Tavily's search API. Registers both the generic `WebSearch` tag and the
provider-typed `TavilySearch` tag. Returns `content` as the result snippet
plus a relevance `score`, maps `includeDomains` / `excludeDomains`
directly, and formats date ranges as `YYYY-MM-DD`. `recency` maps onto
`time_range` (the `hour` granularity has no equivalent and is
`warnDropped`); `country` and `language` are `warnDropped` (Tavily expects
full names rather than ISO codes). Tune relevance via `TavilySearchDepth`
and `TavilyTopic`.
