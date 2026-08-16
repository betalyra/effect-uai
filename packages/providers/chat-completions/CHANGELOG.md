# @effect-uai/chat-completions

## 0.12.0

## 0.11.0

Initial release. A reusable OpenAI Chat Completions (`POST /chat/completions`)
`LanguageModel` base for `@effect-uai/core`: SSE streaming, tools, and
structured output over the legacy chat dialect. Point it at any compatible
endpoint with `baseUrl` (OpenRouter, Requesty, Groq, Together, self-hosted).

Prefer `@effect-uai/responses` when the endpoint speaks the Responses protocol;
this dialect exists for endpoints that do not.
