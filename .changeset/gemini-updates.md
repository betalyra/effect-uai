---
"@effect-uai/core": minor
"@effect-uai/google": minor
---

Gemini updates.

- **`@effect-uai/google/GeminiDecisionModel`**: Google's Decisions API (`gemini-decision-1`) behind the generic `DecisionModel`. All three kinds, Google's `confidence` on every answer on the typed tag, Google's limits checked before sending, and a safety block as `ContentFiltered`.
- **`thinkingLevel`** on `GeminiRequest` (`low` / `medium` / `high`, `minimal` on some Gemini 3 Flash models), for Gemini 3 and 4. `gemini-4-carbon`, `gemini-4-argon` and `gemini-3.8-flash` join `GoogleModel`.
- **Long decode (Gemini 4):** a response cut at Gemini's per-response cap stops with `"max_tokens"` (it used to read as a finished `"stop"`) and carries its continuation token, read with `continuationOf(turn)`; send the same request again with `continuationToken` to continue. The app decides whether to.
- **`Turn.providerData`** (core): optional response-level extras keyed by provider, output only and never sent back with the history. Like `providerData` on image and video responses.
- **Fix:** a response part the adapter doesn't render (code execution's `executableCode` / `codeExecutionResult`, Gemini 4's tool parts) no longer fails the decode and ends the stream; it is skipped.
