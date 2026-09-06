# @effect-uai/perplexity

## 0.14.0

### Patch Changes

- a7e3bc6: Images inside a language-model turn. Some models answer with a picture rather
  than only text, and "make it dawn instead" changes that same picture, so the
  image belongs on the turn instead of behind a separate call.

  - **`output_image`** joins the `ContentBlock` union: a block on the assistant's
    message carrying the same `ImageSource` an `input_image` does.
    `Turn.assistantImages` pulls them out in order. Do not count on the text
    alongside it, since these models often return none.
  - **`ImageOutput`** joins `TurnEvent`, with `partialIndex` set only on a
    preview frame. It also lands on `TurnComplete.turn`, so reading the
    assembled turn misses nothing.
  - **`Turn.imagesAsInput`** restates assistant-drawn images as a following user
    message of `input_image` blocks. Explicit rather than automatic, because
    "the assistant drew this" and "here is an image, look at it" are not the
    same claim.
  - **`Capabilities.warnDroppedBlocks`** reports content a wire has no slot for,
    counted per request.
  - Only Gemini's wire carries an assistant-drawn image, so replaying one there
    is what lets a follow-up edit it. Every other adapter drops the block on
    replay and warns once per request, naming `imagesAsInput` as the way to
    resend it.

  See [images in a turn](https://effect-uai.betalyra.com/language-models/images-in-turns/).

## 0.13.0

## 0.12.1

## 0.12.0

### Minor Changes

- bd55235: Namespace `providerData` per provider, and give it a domain type where a
  consumer is meant to read it.

  **The fix.** `providerData` is a shared slot, but `@effect-uai/responses` wrote
  its wire item to the root of it and re-emitted whatever it found there
  verbatim. An item that had been through another provider first (dynamic
  fallback) was therefore sent as _that provider's_ data, dropping the real
  content. A Gemini-produced `function_call` routed to this provider went on the
  wire as `{"gemini":{"id":...,"thoughtSignature":...}}` instead of a function
  call. Every provider now writes under its own key and reads only that key, so
  several can coexist on one item, and anything that fails to decode is left
  alone and encoded normally.

  **The slot is now typed in our own terms, not the wire's.** Where it exists for
  a consumer to read, it carries a domain value with an exported schema and
  accessor, rather than the raw wire shape. Wire schemas stay internal, so a wire
  change cannot silently alter the published type.
  - `@effect-uai/google` → `GoogleDeepResearch.GeminiResearchData` on
    `providerData.gemini`: `steps`, the research trace of what the model did at
    each step and which sources it consulted there. The `Turn` keeps only the
    final report and the deduped union of sources. Read it with
    `GoogleDeepResearch.researchDataOf(item)`.
  - `@effect-uai/perplexity` no longer writes `providerData` at all. Everything
    it carried is already on the `Turn`: the text, `Turn.usage`, and the search
    results as annotations with their `[n]` markers.
  - `@effect-uai/responses` keeps its wire item internally under
    `providerData.responses`, purely to round-trip `encrypted_content` and item
    ids. It is not part of the public surface.

  **Migration.** Code reading `item.providerData` on a deep-research result needs
  to go one level deeper and will now find a domain value rather than the wire
  payload; prefer the exported `researchDataOf` accessors. Perplexity consumers
  lose the slot entirely. On the Responses path, items persisted by an earlier
  version keep their data at the root and so no longer round-trip: those turns
  fall back to a normal encode and lose `encrypted_content` and item ids, which
  affects only conversations spanning the upgrade.

## 0.11.0

### Minor Changes

- 1efb6b4: New `DeepResearch` capability (additive). Submit a question, a provider runs a
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

## 0.10.0

## 0.9.0

## 0.8.0

### Minor Changes

- 842d92b: New package: `@effect-uai/perplexity`. A `WebSearch` provider backed by
  Perplexity's `/search` endpoint. Registers both the generic `WebSearch`
  tag and the provider-typed `PerplexitySearch` tag. Maps `includeDomains` /
  `excludeDomains` onto `search_domain_filter` (exclusions via the `-`
  prefix), passes `recency` through, formats date ranges as `MM/DD/YYYY`,
  and maps `language` onto `search_language_filter`. Configure the search
  context size via `PerplexitySearchContextSize`.
- 842d92b: 0.8 adds web search. A new `WebSearch` capability lands in core: a generic
  service for "search the live web" that providers register against, a free
  `search` helper, and a `webSearchTool` you hand to the agent loop so the
  model can ground its answers in current results. Three search providers
  debut behind it (`@effect-uai/perplexity`, `@effect-uai/exa`,
  `@effect-uai/tavily`), and two recipes show the patterns end to end:
  [grounded answer](https://effect-uai.betalyra.com/recipes/grounded-answer/)
  (search, read, cite) and
  [deep research](https://effect-uai.betalyra.com/recipes/deep-research/)
  (plan, fan out parallel sub-agents, synthesize a cited report).

  Like the request shape on every other capability, `CommonSearchRequest`
  is the cross-provider intersection (`query`, `maxResults`, `recency`,
  date range, `includeDomains` / `excludeDomains`, `country`, `language`);
  each provider maps what it supports and `warnDropped`s the rest instead
  of silently changing your query. Cost reporting is deliberately left off
  `SearchResponse` for now, deferred to a unified usage-tracking pass.

  **Purely additive. No migration needed.** Bump dependencies, run
  typecheck, done. The new surface is in
  [Migrating to 0.8](https://effect-uai.betalyra.com/migrations/v0-8/).

  Every package outside core and the three new search providers
  (`@effect-uai/responses`, `@effect-uai/anthropic`, `@effect-uai/google`,
  `@effect-uai/jina`, `@effect-uai/openai`, `@effect-uai/elevenlabs`,
  `@effect-uai/inworld`, `@effect-uai/microsandbox`, `@effect-uai/deno`)
  has no functional changes this release; they bump for lockstep versioning
  only.
