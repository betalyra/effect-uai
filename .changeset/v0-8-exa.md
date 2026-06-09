---
"@effect-uai/exa": minor
---

New package: `@effect-uai/exa`. A `WebSearch` provider backed by Exa's
search API. Registers both the generic `WebSearch` tag and the
provider-typed `ExaSearch` tag. Translates `recency` into a computed
`startPublishedDate`, maps `includeDomains` / `excludeDomains` onto Exa's
domain filters, and exposes the provider-typed `ExaSearchType`
(`auto` / `fast` / `neural` / `keyword` / ...) and `ExaCategory`.
`language` is `warnDropped` (no wire field); Exa's `costDollars` is kept
on the raw payload only (cost reporting is deferred to the upcoming
usage-tracking pass).
