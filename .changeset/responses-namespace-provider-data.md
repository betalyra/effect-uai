---
"@effect-uai/responses": minor
"@effect-uai/google": minor
"@effect-uai/perplexity": minor
---

Namespace `providerData` per provider, and give it a domain type where a
consumer is meant to read it.

**The fix.** `providerData` is a shared slot, but `@effect-uai/responses` wrote
its wire item to the root of it and re-emitted whatever it found there
verbatim. An item that had been through another provider first (dynamic
fallback) was therefore sent as _that provider's_ data, dropping the real
content. A Gemini-produced `function_call` routed to this provider went on the
wire as `{"gemini":{"id":...,"thoughtSignature":...}}` instead of a function
call. Every provider now writes under its own key and reads only that key, so
several can coexist on one item, and anything that fails to decode is left
alone and encoded normally.

**The slot is now typed in our own terms, not the wire's.** Where it exists for
a consumer to read, it carries a domain value with an exported schema and
accessor, rather than the raw wire shape. Wire schemas stay internal, so a wire
change cannot silently alter the published type.

- `@effect-uai/google` → `GoogleDeepResearch.GeminiResearchData` on
  `providerData.gemini`: `steps`, the research trace of what the model did at
  each step and which sources it consulted there. The `Turn` keeps only the
  final report and the deduped union of sources. Read it with
  `GoogleDeepResearch.researchDataOf(item)`.
- `@effect-uai/perplexity` no longer writes `providerData` at all. Everything
  it carried is already on the `Turn`: the text, `Turn.usage`, and the search
  results as annotations with their `[n]` markers.
- `@effect-uai/responses` keeps its wire item internally under
  `providerData.responses`, purely to round-trip `encrypted_content` and item
  ids. It is not part of the public surface.

**Migration.** Code reading `item.providerData` on a deep-research result needs
to go one level deeper and will now find a domain value rather than the wire
payload; prefer the exported `researchDataOf` accessors. Perplexity consumers
lose the slot entirely. On the Responses path, items persisted by an earlier
version keep their data at the root and so no longer round-trip: those turns
fall back to a normal encode and lose `encrypted_content` and item ids, which
affects only conversations spanning the upgrade.
