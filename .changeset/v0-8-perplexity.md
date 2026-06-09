---
"@effect-uai/perplexity": minor
---

New package: `@effect-uai/perplexity`. A `WebSearch` provider backed by
Perplexity's `/search` endpoint. Registers both the generic `WebSearch`
tag and the provider-typed `PerplexitySearch` tag. Maps `includeDomains` /
`excludeDomains` onto `search_domain_filter` (exclusions via the `-`
prefix), passes `recency` through, formats date ranges as `MM/DD/YYYY`,
and maps `language` onto `search_language_filter`. Configure the search
context size via `PerplexitySearchContextSize`.
