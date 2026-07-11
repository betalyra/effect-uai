---
"@effect-uai/core": patch
---

Track the latest Effect v4 beta across every package. The `effect` peer
dependency moves from `4.0.0-beta.57` to a range, `>=4.0.0-beta.94 <5.0.0`, so
consumers must be on `effect@4.0.0-beta.94` or newer. This is the one required
action for the upgrade; the API surface is otherwise source-compatible. Most of
the internal diff in this release is the mechanical ripple of that bump. See the
[0.11 migration guide](https://effect-uai.betalyra.com/migrations/v0-11/).
