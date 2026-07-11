---
"@effect-uai/core": minor
---

`Tool.make` and `Tool.provider` now accept an Effect `Schema` directly as
`inputSchema` and adapt it internally, so you no longer wrap it in
`Tool.fromEffectSchema`. The `Input` type is still inferred from the schema.
`fromEffectSchema` / `fromStandardSchema` remain for the explicit path and for
non-Effect Standard Schemas (Zod, Valibot, ArkType). Existing call sites are
unchanged.
