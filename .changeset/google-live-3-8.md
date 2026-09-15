---
"@effect-uai/google": patch
---

Add the Gemini 3.8 Live model ids to `GeminiLiveModel`: `gemini-3.8-live`, now the default choice for a voice agent, and `gemini-3.8-live-extended-thinking`, which reasons in the background during a live exchange at the cost of the latency a spoken turn is most sensitive to.

Both released 2026-09-15 and are stable rather than preview. The union keeps its `(string & {})` tail, so either already worked as a string; this only brings them into autocomplete and the docs. `gemini-3.1-flash-live-preview` and the 2.5 native-audio preview stay listed.
