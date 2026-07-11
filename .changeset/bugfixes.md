---
"@effect-uai/core": patch
"@effect-uai/mistral": patch
---

Bug fixes.

- **`Toolkit.namespace`** now preserves a tool's typed error `E` and requirement
  `R` through the prefixing rewrite (they were previously widened).
- **SSE and JSONL decoders** (`@effect-uai/core/SSE`, `@effect-uai/core/JSONL`)
  are now backed by Effect's `unstable/encoding` primitives, for spec-correct
  framing across chunk boundaries.
- **`Items.UrlCitation`** widens to the provider-agnostic citation shape:
  `start_index` / `end_index` become optional and `cited_text` / `marker` are
  added, so a provider populates whichever anchor it has (offset span, exact
  quote, or positional `[n]` marker) and a bare source list sets none.
- **Mistral** no longer synthesizes a `TurnComplete` for a truncated or failed
  stream, so a halted turn surfaces as a failure instead of a bogus completion.
