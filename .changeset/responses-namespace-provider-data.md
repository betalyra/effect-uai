---
"@effect-uai/responses": minor
"@effect-uai/google": minor
"@effect-uai/perplexity": minor
"@effect-uai/exa": minor
---

Namespace `providerData` per provider, fixing history items being corrupted
when they carry another provider's data.

`providerData` is a shared slot, but `@effect-uai/responses` wrote its wire
item to the root of it and re-emitted whatever it found there verbatim. An item
that had been through another provider first (dynamic fallback) was therefore
sent as _that provider's_ data, dropping the real content. A Gemini-produced
`function_call` routed to this provider went on the wire as
`{"gemini":{"id":...,"thoughtSignature":...}}` instead of a function call.

Every provider now writes under its own key and reads only that key, so several
can coexist on one item:

- `@effect-uai/responses` → `providerData.responses`
- `@effect-uai/google` deep research → `providerData.gemini` (its codec was
  already namespaced)
- `@effect-uai/perplexity` deep research → `providerData.perplexity`
- `@effect-uai/exa` deep research → `providerData.exa`

Anything that fails to decode is left alone and encoded normally, rather than
assumed to be ours.

Items persisted by an earlier version keep their data at the root, so they no
longer round-trip: those turns fall back to a normal encode and lose
`encrypted_content` and item ids on the Responses path. Only in-flight
conversations that span the upgrade are affected. Code reading these fields off
a returned turn (`item.providerData` on a deep-research result) needs to reach
one level deeper.
