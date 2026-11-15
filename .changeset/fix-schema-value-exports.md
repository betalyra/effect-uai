---
"@effect-uai/core": patch
"@effect-uai/responses": patch
"@effect-uai/anthropic": patch
"@effect-uai/ui": patch
"@effect-uai/ai-sdk": patch
---

Export the schema values behind `UserLocation`, `WebSearchFilters`, `WireUsage`, `WebReadToolArgs`, `WebSearchToolArgs`, the `RunView` blocks and the ai-sdk message parts. The published `.d.mts` already declared them, but the `.mjs` did not export them, so imports type-checked and then failed at runtime (#232).
