---
"@effect-uai/core": minor
"@effect-uai/responses": minor
"@effect-uai/google": minor
"@effect-uai/perplexity": minor
"@effect-uai/exa": minor
---

New `DeepResearch` capability (additive). Submit a question, a provider runs a
long-running background research job (many web searches over minutes), and you
collect one cited report.

- **`@effect-uai/core/DeepResearch`**: the generic `DeepResearch` tag and the
  portable accessors `research` (submit and poll to the terminal `Turn`),
  `researchStream` (submit and forward live `TurnEvent`s, terminating in
  `TurnComplete`), plus the detached trio `submit` / `status` / `collect` /
  `streamFrom` / `cancel`. A completed result is a plain `Turn` (project it with
  `Turn.assistantText` / `Turn.citations` / `Turn.decodeStructured`); the
  streaming terminal and the collected value are the same shape.
- **`@effect-uai/core/Job`**: the generic background-job primitive the capability
  is built on. A `JobRef<A>` is serializable `{ _tag, provider, id }` data, so a
  job can be submitted now and collected from a later process. `Job.collect` /
  `Job.run` drive the poll-to-settle loop; `Job.JobConfig` tunes poll cadence
  (default 10s) and overall timeout (default 45m).
- **`@effect-uai/core/Research`** and **`@effect-uai/core/Citation`**: the shared
  `ResearchRequest` and the provider-agnostic `Citation` / `Source` /
  `CitationSpan` model that normalizes how providers link answer text to sources
  (char span, quote, positional marker, or bare source).
- Providers register the generic `DeepResearch` tag plus a provider-typed tag
  for the narrowed knobs: `@effect-uai/responses/OpenAIDeepResearch`
  (`o3-deep-research`, submit creates a streaming background job),
  `@effect-uai/google/GoogleDeepResearch` (Gemini Interactions, real streaming),
  `@effect-uai/perplexity/PerplexityDeepResearch` (`sonar-deep-research`,
  poll-only with a synthesized stream), and `@effect-uai/exa/ExaDeepResearch`
  (`exa-research`, poll-only, with a provider-typed `outputSchema` for
  structured output).

Every provider is modeled as a job (`submit` / `poll` / `cancel`), so
`fromJob(ops, config?)` derives the whole uniform surface once and an
implementor states only its wire calls. See the
[native deep research recipe](https://effect-uai.betalyra.com/recipes/native-deep-research/).
