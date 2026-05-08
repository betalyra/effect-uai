# @effect-uai/core

## Unreleased

### Minor Changes

- New `EmbeddingModel` service — parallel of `LanguageModel` for vectorization.
  Adds `@effect-uai/core/EmbeddingModel` (service tag, `embed` / `embedMany`,
  `CommonEmbedRequest`, cross-provider `Encoding` union) and
  `@effect-uai/core/Embedding` (tagged union of `Float32` / `Int8` / `Binary` /
  `Sparse` / `Multivector` embeddings with predicates, plus `EmbedInput` and
  `Usage`).
- New `@effect-uai/core/Vector` math primitives: dense (`cosine`, `dot`,
  `l2Norm`, `normalize`, `euclidean`), sparse (`sparseCosine`, `sparseDot`,
  `sparseL2Norm`), and multivector (`maxSim`).
- New media domain shared with language-model multimodal inputs:
  `@effect-uai/core/Media` (generic `MediaSource<MimeType>`) and
  `@effect-uai/core/Image` (typed `ImageMimeType` plus `imageUrl` /
  `imageBase64` / `imageBytes` constructors and predicates).

## 0.2.0

### Minor Changes

- Tool approval moves out of the executor. `Toolkit.executeAll(tools, calls)`
  now only runs the calls you pass it; `Resolver`, `executeAllWithResolver`,
  `withPermissions`, and `withFallback` are removed. Recipes call the new
  planners (below) before `executeAll` and merge any rejected results into
  the event stream themselves. The pre-execution `ToolDecision` /
  `execute` / `reject` constructors in `Outcome` are gone with it.
- `Resolvers` reshaped around two planners that return data, not effects:
  - `fromApprovalMap(predicate, approvals)(calls)` returns a `ToolCallPlan`
    (`{ approved, rejected }`) synchronously.
  - `fromVerdictQueue(predicate, queue)(calls)` returns
    `{ approved, decisions, announce }` — `approved` runs immediately,
    `decisions` streams `ToolCallDecision`s as verdicts arrive, `announce`
    surfaces `ApprovalRequested` events for the UI.
  - New helpers: `ToolCallPlan`, `ToolCallDecision`, `approve`, `reject`,
    `splitToolCallDecisions`, `approvalRequested`.
- New `Toolkit.outputEvent(result)` / `Toolkit.outputEvents(results)` for
  turning rejected tool results back into `ToolEvent.Output`s when merging
  with `Toolkit.executeAll`.
- `Turn.appendTurn(state, turn, items?)` replaces the `Cursor<S>` / `cursor`
  pair. State advancement is now a single helper that appends `turn.items`
  plus any follow-up items (typically tool outputs) to `state.history` —
  no intermediate stamped wrapper.
