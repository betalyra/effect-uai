---
"@effect-uai/core": patch
---

Use `Schema.TaggedError` instead of the removed `Schema.TaggedErrorClass`

Effect renamed `Schema.TaggedErrorClass` to `Schema.TaggedError` in
`4.0.0-beta.104`. `Tool.ts` still called the old name, so importing
`@effect-uai/core/Tool` threw `TypeError: Schema.TaggedErrorClass is not a
function` on every Effect from `beta.104` onward, including the current `beta`
and `rc` dist-tags. The argument shape is unchanged, so this is a rename only.
