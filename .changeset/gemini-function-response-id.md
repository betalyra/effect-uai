---
"@effect-uai/google": patch
---

Carry the originating tool-call id back on Gemini `functionResponse` items. When
a tool result is replayed, the codec now matches it to its `function_call` in
history and re-attaches the id Gemini minted. Without it, parallel calls to the
same function were mis-paired on the next turn.
