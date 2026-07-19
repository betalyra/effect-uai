---
"@effect-uai/responses": minor
---

Fix history items being corrupted when they carry another provider's
`providerData`.

`providerData` is a shared slot, but this codec wrote its wire item to the root
of it and re-emitted whatever it found there verbatim. An item that had been
through another provider first (dynamic fallback) was therefore sent as _that
provider's_ data, dropping the real content. A Gemini-produced `function_call`
routed to this provider went on the wire as
`{"gemini":{"id":...,"thoughtSignature":...}}` instead of a function call.

Both sides are now namespaced under a `responses` key, and anything that fails
to decode is left alone and encoded normally.

Items persisted by an earlier version keep their data at the root, so they no
longer round-trip: those turns fall back to a normal encode and lose
`encrypted_content` and item ids. Only in-flight conversations that span the
upgrade are affected.
