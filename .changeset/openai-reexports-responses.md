---
"@effect-uai/openai": minor
"@effect-uai/responses": minor
---

`@effect-uai/openai` now re-exports the OpenAI surfaces of
`@effect-uai/responses`, so one install covers the whole OpenAI stack:
Responses language models, embeddings, deep research, and speech.

New subpaths (and matching namespaces on the package root):
`@effect-uai/openai/Responses`, `@effect-uai/openai/OpenAIEmbedding`,
`@effect-uai/openai/OpenAIDeepResearch`, `@effect-uai/openai/ResponsesTools`.
`@effect-uai/responses` is now a dependency of `@effect-uai/openai`.

`@effect-uai/responses` stays a standalone install for protocol-only use (any
endpoint speaking the Responses API, including gateways), and gains a
`./ResponsesTools` subpath export for its built-in tool helpers.
