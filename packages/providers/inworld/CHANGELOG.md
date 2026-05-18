# @effect-uai/inworld

## 0.6.0

### Minor Changes

- `InworldSynthesizer` implements the new `SpeechSynthesizerService`
  dialogue methods (`synthesizeDialogue`, `streamSynthesizeDialogue`) —
  both fail with `AiError.Unsupported`. The Layer does NOT ship the
  `MultiSpeakerTts` marker; multi-speaker calls fail at compile time.
- `pronunciations` on `CommonSynthesizeRequest` are applied as inline
  `/ipa/` tokens in `text` (Inworld's documented mechanism). Only `ipa`
  entries are honored; `x-sampa` and `cmu-arpabet` entries are silently
  dropped. English-only.

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
  import { retry } from "@effect-uai/core/LanguageModel";
  streamTurn(req).pipe(retry(schedule));

  // After
  import * as Retry from "@effect-uai/core/Retry";
  streamTurn(req).pipe(Retry.stream(schedule));
  embed(req).pipe(Retry.effect(schedule));
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

- Initial release. Inworld speech provider package.
- `@effect-uai/inworld/InworldSynthesizer` — TTS layer for the generic
  `SpeechSynthesizer` service. Sync `synthesize` for finished text.
- `@effect-uai/inworld/InworldRealtimeSynthesizer` — incremental
  text-in TTS over WebSocket; registers `TtsIncrementalText`.
- `@effect-uai/inworld/InworldTranscriber` — STT layer for the generic
  `Transcriber` service. Sync `transcribe` for whole-file audio.
- `@effect-uai/inworld/InworldRealtimeTranscriber` — live STT over
  WebSocket; registers `SttStreaming` and emits partial + final
  transcript events.
