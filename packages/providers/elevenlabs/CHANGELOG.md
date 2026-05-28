# @effect-uai/elevenlabs

## 0.6.0

### Minor Changes

- 0.6 bundles one large-but-mechanical naming sweep with a set of
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

  ### Additive: multi-speaker dialogue + custom pronunciations

  `SpeechSynthesizerService` gains `synthesizeDialogue` /
  `streamSynthesizeDialogue` taking a `CommonSynthesizeDialogueRequest`
  (`{ model, turns, outputFormat?, languageCode?, pronunciations? }`)
  where `DialogueTurn` is `{ voiceId, text, styleDescription?, speed? }`.
  Gated by a new `MultiSpeakerTts` capability marker — provider Layers
  without native dialogue support don't ship it and dialogue-less code
  fails at compile time.

  `CommonSynthesizeRequest` gains optional `pronunciations` —
  `ReadonlyArray<CustomPronunciation>` where each entry is
  `{ phrase, pronunciation, encoding }` and `encoding` is
  `"ipa" | "x-sampa" | "cmu-arpabet"`. Adapters drop entries they can't
  honor and still render the default pronunciation.

  ### Additive: new Toolkit / Loop helpers
  - `Toolkit.appendToolResults(state, turn)` — shorthand for the canonical
    `continueWithResults` body that folds tool results into history.
  - `Toolkit.collectResults` — lower-level drain of a `Stream<ToolEvent>`
    to its `ToolResult`s without advancing the loop.
  - `Loop.emitValues(stream)` / `Loop.emitNext(effect)` — fork-helper
    building blocks behind `Toolkit.continueWithResults`.

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
  - `external-task-polling` — drive the loop from an external task
    queue.
  - `sandbox-code-interpreter` (in `recipes-extras/`) — agent writes
    Python, sandbox runs it, stderr feeds back into the next turn.

## 0.6.0

### Minor Changes

- Wire `ElevenLabsSynthesizer` to the new core dialogue + pronunciation
  surface:
  - `synthesizeDialogue` → `POST /v1/text-to-dialogue` (raw audio bytes).
  - `streamSynthesizeDialogue` → `POST /v1/text-to-dialogue/stream`
    (chunked binary).
  - Layer now also registers the `MultiSpeakerTts` capability marker
    (alongside `TtsIncrementalText`). Per-turn `styleDescription` and
    `speed` are silently ignored — ElevenLabs `inputs[]` takes
    `{voice_id, text}` only.
  - `pronunciations` are applied as inline SSML `<phoneme alphabet="ipa|cmu-arpabet" ph="...">phrase</phoneme>`
    tags for the phoneme-gated legacy models (`eleven_flash_v2`,
    `eleven_english_v1`, `eleven_monolingual_v1`). Other models silently
    drop the overrides. `x-sampa` entries are always dropped.
- Add optional `region` field to every `Config` (`ElevenLabsSynthesizer`,
  `ElevenLabsTranscriber`, `realtimeTts`, `realtimeStt`). Typed union
  `ElevenLabsRegion = "default" | "eu" | "in" | (string & {})`; resolves to
  `api.{eu,in}.residency.elevenlabs.io` (REST + WSS). Reminder: ElevenLabs
  API keys are workspace-bound — pair an EU-workspace key with `region:
"eu"`. `baseUrl` continues to win when set; unknown region strings pass
  through as residency host prefixes for forward compat. Exports a
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

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.5.0` — see core changelog.
  No source changes; speech-only package.

## 0.4.0

### Minor Changes

- 70c8522: Add STT and TTS

## 0.4.0

### Minor Changes

- Initial release. ElevenLabs speech provider package.
- `@effect-uai/elevenlabs/ElevenLabsSynthesizer` — TTS layer for the
  generic `SpeechSynthesizer` service. Sync `synthesize` plus
  `streamSynthesisFrom` for incremental text-in over the streaming
  WebSocket; registers `TtsIncrementalText` so callers can demand
  live-text TTS at the type level. PCM and container output formats.
- `@effect-uai/elevenlabs/ElevenLabsTranscriber` — STT layer for the
  generic `Transcriber` service. Sync `transcribe` plus
  `streamTranscriptionFrom` against Scribe v2 Realtime; registers
  `SttStreaming`. 16 kHz pcm16 input; partial + final transcript
  events with `speech-started` / `speech-stopped` boundaries.
