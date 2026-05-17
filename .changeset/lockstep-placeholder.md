---
"effect-uai": patch
"@effect-uai/core": patch
"@effect-uai/responses": patch
"@effect-uai/anthropic": patch
"@effect-uai/google": patch
"@effect-uai/jina": patch
"@effect-uai/openai": patch
"@effect-uai/elevenlabs": patch
"@effect-uai/inworld": patch
---

The bare `effect-uai` name-squat package now ships in lockstep with
every `@effect-uai/*` scoped package via changesets' `fixed` group —
no more drift between the placeholder and the real packages. No
functional changes in this release; the package remains a name
reservation, install [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core)
and the provider packages.
