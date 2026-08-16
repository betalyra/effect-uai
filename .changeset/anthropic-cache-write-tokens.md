---
"@effect-uai/anthropic": patch
"@effect-uai/core": minor
---

Report Anthropic cache-creation (write) tokens, and fix a stale `total_tokens`
on streamed turns.

Anthropic bills input across three separate buckets: `input_tokens`
(post-breakpoint), cache reads, and cache writes. The provider decoded the
write bucket but dropped it, so a turn that populated the cache logged
`cached 0` and the priciest tokens were invisible in telemetry.

- `Items.Usage.input_tokens_details` gains `cache_write_tokens` (mirrors the
  OpenAI Responses usage field name). Note `cached_tokens` / `cache_write_tokens`
  are provider-relative: Anthropic reports `input_tokens` as post-breakpoint
  only, so the buckets are additive; OpenAI counts cache reads inside
  `input_tokens`. Read each provider's usage in its own terms.
- The anthropic codec now maps `cache_creation_input_tokens` to
  `cache_write_tokens` and computes `total_tokens` from the accumulated usage
  (all input buckets plus output). Previously `total_tokens` was set from a
  single wire event, leaving it frozen at the `message_start` figure for
  streamed turns.
- `Metrics` folds it in alongside cached tokens: `tokenTotals` cumulates it and
  emits an `effect_uai_cache_write_tokens` counter measurement.
