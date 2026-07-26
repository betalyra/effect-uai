---
"@effect-uai/exa": minor
---

Remove `@effect-uai/exa/ExaDeepResearch`. Exa retired the Research API
(`POST /research/v0/tasks` now returns `RESEARCH_RETIRED`), so the capability
could no longer succeed. The replacement (Exa's general Agent API) is a broader
primitive than deep research and does not fit the `DeepResearch` capability; a
dedicated managed-agent capability is tracked separately.

`@effect-uai/exa/ExaSearch` and `@effect-uai/exa/ExaContents` are unaffected.
For provider-hosted deep research, use `OpenAIDeepResearch`,
`PerplexityDeepResearch`, or `GoogleDeepResearch`.
