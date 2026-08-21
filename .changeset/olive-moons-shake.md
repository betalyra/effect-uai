---
"@effect-uai/core": patch
---

Require Effect `4.0.0-rc.111`

The `effect` peer range moves from `>=4.0.0-beta.94 <5.0.0` to
`>=4.0.0-rc.111 <5.0.0` across every package. Effect's rc line changed APIs the
beta line still had (for example `Schedule.both` is gone in favour of
`Schedule.upTo`), so a beta install is no longer supported.
