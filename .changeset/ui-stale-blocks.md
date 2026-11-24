---
"@effect-uai/ui": minor
---

Stored views keep working when a tool's schemas change.

- **Breaking:** decoding a stored `RunView` or `Thread` (a contract's or the untyped one) no longer fails when a block or interrupt doesn't match the current schemas, e.g. a tool output that gained a required field after the thread was saved. That element becomes `RunView.Stale { type: "stale", value, issue }`: `value` is the JSON as stored and encodes back unchanged, `issue` says why it didn't decode. `Block` and `RunView.interrupts` include `Stale`, so a renderer that switches over `block.type` needs a `"stale"` case.
- `RunView.stale(view)` and `Thread.stale(thread)` list the stale elements, to log or report them, or to fail on them where strictness is wanted (e.g. a test that decodes stored threads).
- Live envelopes stay strict: a listed payload that doesn't decode still fails `contract.decode`.
- Stored views now always encode to JSON (`toCodecJson` per block), so `contract.Thread` can be used on a stored value directly.
