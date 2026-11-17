---
"@effect-uai/core": patch
---

Fix: structured output and tool inputs built from an Effect schema (`StructuredFormat.fromEffectSchema`, `Tool.fromEffectSchema`) send closed objects (`additionalProperties: false`) again. Effect 4.1 leaves them open by default, which OpenAI's Responses API rejects as `invalid_json_schema`, so every Effect-schema structured-output call on it failed. Decoding is unchanged.
