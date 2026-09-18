# @effect-uai/typesafe-ai

## 0.17.0

### Minor Changes

- 7d48136: New package: `@effect-uai/typesafe-ai`, the TypeSafe AI provider for `DecisionModel`, serving Jev over `POST /v1/systemone`.

  `layer({ apiKey, baseUrl? })` registers the typed `Jev` tag and the generic `DecisionModel` tag from one implementation. All three decision kinds are supported: `classify` maps to a `choice` question, `rate` to a `score` rubric, `probability` to a `noul`.

  - One request per `decide` call, every decision in the definition included, so the encoded input is billed once. The input goes out through `inputSchema`; an input the schema cannot encode fails `InvalidRequest` with `param: "input"`.
  - The typed `Jev` tag adds Jev's own `confidence` on every `classify` and `rate` answer. It is not on the generic answer because its formula is undocumented and `probability` answers do not carry one.
  - `JevDecideRequest` narrows `model` to `jev-latest`, `jev-preview` and `jev-1.13.0`, with a `(string & {})` tail for new releases.
  - Rubric probabilities are read positionally against the rubric that was sent, and `legend` is echoed from the request rather than trusted from the response. An answer whose shape does not match the decision that asked for it fails `GenerationFailed`.
  - HTTP failures map to the house `AiError` table: 401/402/403 `AuthFailed`, 408/504 `Timeout`, 413 `ContextLengthExceeded`, 429 `RateLimited`, 5xx `Unavailable`, other 4xx `InvalidRequest`.

  Experimental, like the capability it serves. See [Decision models](https://effect-uai.betalyra.com/decisions/) and the [decision triage](https://effect-uai.betalyra.com/recipes/decision-triage/) recipe.
