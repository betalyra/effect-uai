---
"@effect-uai/responses": minor
---

- Add optional `region` field to both `Config`s (`Responses`,
  `OpenAIEmbedding`). Typed union `OpenAiRegion = "default" | "eu" | (string &
  {})`; resolves to `eu.api.openai.com` for EU-residency projects. `baseUrl`
  continues to win when set; unknown region strings pass through as host
  prefixes (`{region}.api.openai.com/v1`) for forward compat. Exports a
  `resolveHost(cfg)` helper. Non-breaking.
