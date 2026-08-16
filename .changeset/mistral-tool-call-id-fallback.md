---
"@effect-uai/mistral": patch
---

Fix synthesized tool-call ids failing Mistral's `^[a-zA-Z0-9]{9}$` validation.
When a streaming tool-call chunk omits its id, the fallback is now a 9-char
zero-padded index instead of `call_<index>`, which Mistral rejected with a 422
once the id was replayed on the next turn.
