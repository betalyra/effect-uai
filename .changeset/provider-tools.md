---
"@effect-uai/core": minor
"@effect-uai/responses": minor
"@effect-uai/google": minor
"@effect-uai/anthropic": minor
---

Native grounding: provider-hosted tools now render end to end (additive). Add a
provider tool to a `Toolkit` alongside your function tools and the adapter maps
it to the model's native `tools` entry, so the model can search the web, ground
against Google Search, run code, or read files without you wiring the loop.

- **`@effect-uai/core/Tool`**: `Tool.isProviderTool` and `Tool.providerToolsOf`
  partition provider tools out of a toolkit so an adapter can render them
  separately from the function declarations.
- **`@effect-uai/responses/ResponsesTools`**: `webSearchTool`,
  `codeInterpreterTool`, `fileSearchTool` (OpenAI-hosted).
- **`@effect-uai/google/GeminiTools`**: `googleSearchTool`, `urlContextTool`,
  `codeExecutionTool` (Gemini-hosted).
- **`@effect-uai/anthropic/AnthropicTools`**: `webSearchTool`,
  `codeExecutionTool` (Anthropic-hosted).

A provider tool the target adapter cannot render (a foreign `provider` or an
unrecognized `config`) fails a typed `AiError.Unsupported` rather than being
dropped. See the
[native grounding recipe](https://effect-uai.betalyra.com/recipes/native-grounding/).
