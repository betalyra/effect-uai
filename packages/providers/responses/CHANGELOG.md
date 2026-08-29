# @effect-uai/responses

## 0.12.1

## 0.12.0

### Minor Changes

- a739370: `@effect-uai/openai` now re-exports the OpenAI surfaces of
  `@effect-uai/responses`, so one install covers the whole OpenAI stack:
  Responses language models, embeddings, deep research, and speech.

  New subpaths (and matching namespaces on the package root):
  `@effect-uai/openai/Responses`, `@effect-uai/openai/OpenAIEmbedding`,
  `@effect-uai/openai/OpenAIDeepResearch`, `@effect-uai/openai/ResponsesTools`.
  `@effect-uai/responses` is now a dependency of `@effect-uai/openai`.

  `@effect-uai/responses` stays a standalone install for protocol-only use (any
  endpoint speaking the Responses API, including gateways), and gains a
  `./ResponsesTools` subpath export for its built-in tool helpers.

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

- 1efb6b4: Native grounding: provider-hosted tools now render end to end (additive). Add a
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

## 0.10.0

## 0.9.0

## 0.8.0

### Minor Changes

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

## 0.7.0

### Minor Changes

- 602bfa9: 0.7 is a capability-honesty pass across every audio and embedding
  surface. The unifying rule: where a provider cannot honor a request, the
  call now fails with `AiError.Unsupported` (load-bearing gaps) or emits a
  structured `warnDropped` (best-effort hints), instead of silently
  substituting a different result. Alongside that, `Duration` replaces raw
  `durationSeconds` everywhere audio carries a length, the `MusicGenerator`
  surface is reshaped, an ElevenLabs music provider lands, and Gemini
  `toolChoice` is now mapped.

  Most of it is mechanical (find-and-replace renames plus a
  `Duration.seconds(n)` wrap). The parts that need judgement are the
  removed `GeminiTranscriber` (use OpenAI / ElevenLabs / Inworld instead)
  and the requests that now error where they previously degraded silently.
  The full before/after diffs and the recommended order live in
  [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).

  `@effect-uai/anthropic`, `@effect-uai/microsandbox`, and
  `@effect-uai/deno` have no functional changes this release; they bump for
  lockstep versioning only.

- 602bfa9: - **`OpenAIEmbedding`**: a non-`float32` `encoding` now fails
  `AiError.Unsupported` via `assertEncoding` instead of returning a
  mislabeled float32 vector; image input now fails `Unsupported` (was
  `InvalidRequest`); `task` now `warnDropped` (OpenAI embeddings have no
  task field).

  See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).

## 0.6.0

### Minor Changes

- a332f0a: 0.6 bundles one large-but-mechanical naming sweep with a set of
  additive features. The breaking part is source-level only — **the wire
  format is unchanged** (`function_call` / `function_call_output` still
  go out on the wire, so no provider payloads change). Almost every
  rewrite is find-and-replace; the full before/after diffs and the
  recommended order live in [Migrating to 0.6](https://effect-uai.betalyra.com/migrations/v0-6/).

  ### Breaking: "function call" → "tool call" terminology

  Every public name that said "function call" now says "tool call":
  - `Item` → `HistoryItem`; `FunctionCall` → `ToolCall`;
    `FunctionCallOutput` → `ToolCallOutput`.
  - `Items.functionCallOutput` → `Items.toolCallOutput`;
    `Items.isFunctionCall` → `Items.isToolCall`;
    `Items.isFunctionCallOutput` → `Items.isToolCallOutput`.
  - `Turn.functionCalls` → `Turn.getToolCalls`.

  ### Breaking: module renames
  - `@effect-uai/core/Outcome` → `@effect-uai/core/ToolResult`. Also
    `ToolResult.Value` → `ToolResult.Ok`, `isValue` → `isOk`,
    `rejected(...)` → `failed(...)`, `toFunctionCallOutput` →
    `toToolCallOutput`.
  - `@effect-uai/core/Resolvers` → `@effect-uai/core/Approval`. Also
    `fromApprovalMap` → `fromMap`, `fromVerdictQueue` → `fromQueue`,
    `ToolCallDecision` → `ApprovalDecision`, and the queue helper's
    `announce` field → `approvalRequests`.

  ### Breaking: Turn / Toolkit / Tool / ToolEvent renames
  - `Turn.appendTurn` → `Turn.appendToHistory`.
  - `Turn.toStructured` → `Turn.decodeStructured`.
  - `Toolkit.executeAll` → `Toolkit.run`.
  - `Toolkit.continueWith` → `Toolkit.continueWithResults`.
  - `Toolkit.make(...)` + `Toolkit.toDescriptors(kit)` → just
    `Tool.toDescriptors([...])`. The homogeneous-toolkit wrapper is gone.
  - `Tool.AnyKindTool` → `Tool.AnyTool`.
  - `ToolEvent.Intermediate` → `ToolEvent.Progress`;
    `isIntermediate` → `isProgress`.

  ### Breaking: Loop helper trim
  - `Loop.loopFrom(...)` → `Loop.loopOver(...)`.
  - `Loop.Event<A, S>` → `Loop.Step<A, S>`.
  - `return stop` → `return stop()`.
  - `Loop.stopWith(state)` → `Loop.stop(state)`.
  - `nextAfter` / `stopAfter` / `stopWithAfter` / `stopEvent` /
    `nextAfterFold` are removed — compose with `Stream.concat` instead.
    See the migration doc for one-line replacements.

  ### Additive: new Toolkit / Loop helpers
  - `Toolkit.appendToolResults(state, turn)` — shorthand for the canonical
    `continueWithResults` body that folds tool results into history.
  - `Toolkit.collectResults` — lower-level drain of a `Stream<ToolEvent>`
    to its `ToolResult`s without advancing the loop.

  ### Additive: sandboxes

  A new `Sandbox` capability in `@effect-uai/core/sandbox` for running
  untrusted code, commands, or LLM-generated scripts inside an isolated
  microVM. Two new provider packages ship behind the same
  `SandboxService`:
  - **`@effect-uai/microsandbox`** — local Firecracker microVMs via
    [microsandbox](https://github.com/microsandbox/microsandbox).
  - **`@effect-uai/deno`** — hosted Firecracker microVMs on
    [Deno Deploy](https://docs.deno.com/deploy/).

  Both cover `create` / `exec` / `execStream` / volumes / snapshots /
  network policies / bound secrets / OCI image references. The
  `recipes-extras/sandbox-code-interpreter` recipe shows the "run, fix,
  repeat" pattern.

  ### Additive: new recipes
  - `sleeper-agent` — long-lived background agent waking on scheduled
    triggers.
  - `sandbox-code-interpreter` (in `recipes-extras/`) — agent writes
    Python, sandbox runs it, stderr feeds back into the next turn.

- a332f0a: - Add optional `region` field to both `Config`s (`Responses`,
  `OpenAIEmbedding`). Typed union `OpenAiRegion = "default" | "eu" | (string &
{})`; resolves to `eu.api.openai.com` for EU-residency projects. `baseUrl`
  continues to win when set; unknown region strings pass through as host
  prefixes (`{region}.api.openai.com/v1`) for forward compat. Exports a
  `resolveHost(cfg)` helper. Non-breaking.

## 0.5.2

### Patch Changes

- 1509883: Two related refactors. Both are breaking but mechanical — a one-line
  rewrite per affected call site.

  ### `Retry` is its own module

  `LanguageModel.retry` and `LanguageModel.Retryable` were not
  LanguageModel-specific — the implementation was a generic `AiError`
  combinator. Hoisted out into `@effect-uai/core/Retry`, with two
  carriers so it covers every model surface:
  - `Retry.stream(schedule)` — for `Stream<A, AiError, R>` (`streamTurn`,
    `streamSynthesis`, `streamTranscriptionFrom`).
  - `Retry.effect(schedule)` — for `Effect<A, AiError, R>` (`turn`,
    `embed`, `embedMany`, `synthesize`, `transcribe`).

  Both gate on the `RateLimited | Unavailable | Timeout` subset; other
  `AiError`s propagate unchanged. The namespace deliberately doesn't
  shadow Effect's own `Stream.retry` / `Effect.retry`.

  ```ts
  // Before
  import { retry } from "@effect-uai/core/LanguageModel"
  streamTurn(req).pipe(retry(schedule))

  // After
  import * as Retry from "@effect-uai/core/Retry"
  streamTurn(req).pipe(Retry.stream(schedule))
  embed(req).pipe(Retry.effect(schedule))
  ```

  `Retryable` and `isRetryable` move to the same module.

  ### `turn` is now on `LanguageModelService`

  `turn(request): Effect<Turn, AiError>` is now a method on the service
  alongside `streamTurn`. Providers without a native non-streaming
  endpoint derive it from `streamTurn` via the new
  `LanguageModel.turnFromStream(streamTurn)` helper; providers with a
  native complete endpoint can override.

  The top-level `LanguageModel.turn(request)` helper is unchanged at
  call sites — it now delegates to the service method instead of
  draining `streamTurn` inline.

  Hand-rolled `LanguageModelService` values (most commonly in tests)
  must now supply a `turn` field. Use `turnFromStream`:

  ```ts
  // Before
  const service: LanguageModelService = {
    streamTurn: () => Stream.fromIterable([...]),
  }

  // After
  import { turnFromStream } from "@effect-uai/core/LanguageModel"
  const streamTurn: LanguageModelService["streamTurn"] = () => Stream.fromIterable([...])
  const service: LanguageModelService = { streamTurn, turn: turnFromStream(streamTurn) }
  ```

## 0.5.1

### Patch Changes

- 4d83b13: The bare `effect-uai` name-squat package now ships in lockstep with
  every `@effect-uai/*` scoped package via changesets' `fixed` group —
  no more drift between the placeholder and the real packages. No
  functional changes in this release; the package remains a name
  reservation, install [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core)
  and the provider packages.

## 0.5.0

### Minor Changes

- `OpenAIEmbedding` returns the precise `EmbeddingFor<E>` variant on the
  generic `EmbeddingModel` path. OpenAI only emits `float32` at runtime;
  callers asking for another encoding via the generic tag get the type they
  requested but the runtime value is still float32.
- Provider emitters now use `TurnEvent.TextDelta({...})` / `TurnEvent.ToolCallStart({...})`
  / etc. constructors. No wire-shape change for downstream consumers.

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.5.0` — see core changelog
  for `TurnEvent` tagged-enum migration, `Encoding` → `EmbedEncoding`
  rename, generic `EmbedResponse<E>`, removed `Toolkit.outputEvent` /
  `outputEvents`, new `Loop.stopWith` / `loopFrom`, `LanguageModel.turn` /
  `retry`, `Tool.fromStandardSchema`.

## 0.4.0

### Minor Changes

- 70c8522: Add STT and TTS

## 0.4.0

### Minor Changes

- New `@effect-uai/responses/OpenAIEmbedding` sub-path: `OpenAIEmbedding`
  service tag, `layer`, `OpenAIEmbedRequest`, and `OpenAIEmbeddingModel`
  literal union. Text-only; Matryoshka via `dimensions`; `task` is omitted
  from the typed request (compile error) and ignored on the generic
  `EmbeddingModel` registration.

### Patch Changes

- Updated dependencies for `@effect-uai/core` (new embedding subsystem;
  `Match` module / `matchType` helper removed; `Loop.streamUntilComplete`
  renamed to `Loop.onTurnComplete`; `Toolkit.nextStateFrom` renamed to
  `Toolkit.continueWith` and now pipe-friendly — see core changelog).

## 0.3.0

### Minor Changes

- 1d33c63: Embeddings and simplifications
  - Adds embeddings
  - Rename core primitives to simplify DX
  - Add loopWithState
  - General improvements

## 0.2.0

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.2.0` (tool-approval and
  state-advancement APIs reshaped — see core changelog). No source changes
  in this package.
  - @effect-uai/core@0.2.0
