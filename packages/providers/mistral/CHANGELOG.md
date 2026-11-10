# @effect-uai/mistral

## 0.19.0

### Minor Changes

- 13dc342: Tool output redesign: tools return typed values, including images and files.

  - A tool's `run` returns an `Effect` or a `Stream` (no `emit`): each stream element is a typed `ToolEvent.Partial` as soon as it is produced, and the last is also the result. `Tool.make` requires `run` and `outputSchema`, whose encoded side must be JSON; `Content.Value` is the explicit "anything" (text, JSON, `Content.Image` / `Content.File`, or an array of JSON and media). `Tool.declare` builds a tool without `run`, model-visible and handled by the loop (a signal, or a call answered elsewhere); `Tool.withRun` turns it into a `Tool`. `Toolkit.split(toolkit, turn)` sorts a turn's calls into `run`, `declared` (decoded, typed per tool for an exhaustive `Match`) and `invalid`; `Toolkit.complete` answers a call with a value typed by `outputSchema`.
  - Errors listed in a tool's `failureSchema` reach the model as typed values; any other error fails `Toolkit.run`'s stream. Calls that never ran fail with `InputInvalid`, `OutputInvalid` or `UnknownTool`. `Toolkit.describeFailures` maps undeclared errors to `ToolFailed`, or keeps them fatal when `describe` returns `undefined`.
  - History holds typed parts: `ToolCallOutput.output` is `input_text | input_json | input_image | input_file` plus `isError`. `Toolkit.output` encodes an outcome with the tool's schemas, `Toolkit.decode` reads it back. Each provider serializes once: native media parts on Responses and Anthropic (`is_error` on Anthropic), an object in Gemini's `functionResponse` with media in `parts`, and `AiError.Unsupported` for media on text-only tool messages (Chat Completions, Mistral, OpenAI Realtime). MCP images, audio and resources arrive as media.
  - `Toolkit.next(toolkit, state, turn)` replaces `continueWithResults(appendToolResults(...))`; `continueWith` and `appendResults` remain as its halves. `Tool.declare` replaces `Tool.signal` / `Tool.interaction`. Removed: `ToolResult`, `Tool.execute`, `Toolkit.collectResults`, `ToolEvent.Progress` / `ApprovalRequested`.
  - `Approval` is renamed `ToolDecision` (`Approval.decisions` is `ToolDecision.make`): answers are any decision about a waiting tool call, not only approval. `ToolDecision.make` defines the possible answers and groups waiting calls (`resolve`: `answered` for an exhaustive `Match`, groups per tag, and `invalid` for answers it doesn't take or conflicting ones); `ToolDecision.closesWith` marks an answer that ends the call with its error; `ToolDecision.byTool` gives each tool its own answers. `ToolDecision.Default` and `ToolDecision.Denied` cover the common case. Decisions stay app code: a gated tool only declares its closings in `failureSchema` (or `Tool.withFailures`), and `Toolkit.close(toolkit, "tool", call, error)` builds the outcome. `fromMap` and the decision helpers are removed. `HistoryCheck.cancelAllPending` returns `Cancelled` outputs ready to append.
  - `@effect-uai/ui` protocol v2: `tool-partial` and `tool-result { result: Success | Failure }`, typed per tool by the contract (failures from each tool's `failureSchema` and core's errors). `Projection.toRunEvents({ contract })` encodes (contract required), `Content.Value` travels as typed parts so JSON can't pass for media, `Input` answers carry typed decisions.
  - `Loop.loop` and `onTurnComplete` infer a body's outer Effect error separately from its stream's.

  See the 0.19 migration page.

### Patch Changes

- Updated dependencies [13dc342]
  - @effect-uai/chat-completions@0.19.0

## 0.18.0

### Minor Changes

- cea6f3d: Realtime transcription and synthesis streams now fail when they should, instead of ending as if they had finished.

  - A dropped connection (any close other than 1000, 1001 or 1005) fails the stream with `AiError`. Before, the transcript or audio simply ended, so a caller could not tell a finished stream from a broken one, and retry or fallback never ran.
  - An error in the input stream (the audio for transcription, the text for synthesis) fails the output stream with that error. Before, it was swallowed and the session ran on until the server closed it.

  Both match the declared `AiError | E` error type. A clean server close still ends the stream normally.

  `MistralRealtimeTranscriber`'s config gains an optional `webSocket` to build the socket yourself, for a proxy or an in-memory transport. The default still attaches the bearer token through the `ws` package.

### Patch Changes

- @effect-uai/chat-completions@0.18.0

## 0.17.0

### Patch Changes

- @effect-uai/chat-completions@0.17.0

## 0.16.0

### Patch Changes

- @effect-uai/chat-completions@0.16.0

## 0.15.0

### Patch Changes

- @effect-uai/chat-completions@0.15.0

## 0.14.0

### Patch Changes

- c49ff25: Fix multipart uploads hanging forever under `NodeHttpClient.layerUndici`.

  `HttpClientRequest.bodyFormData` keeps the `FormData` object, and the Undici
  client passes it straight to `dispatcher.request`, which cannot serialise it:
  the request is never sent, and the effect waits with no error and no timeout.
  The `node:http` and fetch clients encode first, so only Undici was affected,
  which made JSON endpoints work while every multipart one on the same provider
  hung. This hit OpenAI image edits and transcription, ElevenLabs
  speech-to-text, and Mistral transcription.

  New `@effect-uai/core/Multipart` exports `bodyMultipart`, which encodes the
  form to bytes and sets the boundary content-type, so the request works on
  every client. All four call sites use it.

- Updated dependencies [a7e3bc6]
  - @effect-uai/chat-completions@0.14.0

## 0.13.0

### Patch Changes

- @effect-uai/chat-completions@0.13.0

## 0.12.1

### Patch Changes

- @effect-uai/chat-completions@0.12.1

## 0.12.0

### Patch Changes

- a739370: Rebuild the Mistral language model on `@effect-uai/chat-completions`. Mistral
  speaks the OpenAI chat-completions dialect, so it now shares the streaming
  decoder and tool encoding with the generic base, keeping only its wire quirks
  local (bare-string `image_url`, `tool_choice: "any"`, and the `model_length`
  finish reason). No public API change; `@effect-uai/chat-completions` becomes a
  dependency.
- a739370: Fix synthesized tool-call ids failing Mistral's `^[a-zA-Z0-9]{9}$` validation.
  When a streaming tool-call chunk omits its id, the fallback is now a 9-char
  zero-padded index instead of `call_<index>`, which Mistral rejected with a 422
  once the id was replayed on the next turn.
  - @effect-uai/chat-completions@0.12.0

## 0.11.0

### Patch Changes

- 1efb6b4: Bug fixes.
  - **`Toolkit.namespace`** now preserves a tool's typed error `E` and requirement
    `R` through the prefixing rewrite (they were previously widened).
  - **SSE and JSONL decoders** (`@effect-uai/core/SSE`, `@effect-uai/core/JSONL`)
    are now backed by Effect's `unstable/encoding` primitives, for spec-correct
    framing across chunk boundaries.
  - **`Items.UrlCitation`** widens to the provider-agnostic citation shape:
    `start_index` / `end_index` become optional and `cited_text` / `marker` are
    added, so a provider populates whichever anchor it has (offset span, exact
    quote, or positional `[n]` marker) and a bare source list sets none.
  - **Mistral** no longer synthesizes a `TurnComplete` for a truncated or failed
    stream, so a halted turn surfaces as a failure instead of a bogus completion.

## 0.10.0

## 0.9.0

### Minor Changes

- a56e470: New provider `@effect-uai/mistral` (additive). One brand covering three
  capability surfaces:
  - **Language model**: Mistral chat models behind the generic `LanguageModel`
    tag.
  - **Speech to text**: Voxtral batch and realtime (streaming) transcription
    behind `Transcriber`.
  - **Text to speech**: Voxtral synthesis behind `SpeechSynthesizer`.

  Provide `mistral({ apiKey })` and your capability-tag code resolves, unchanged.
  Because all three surfaces share one brand, an entire STT to LLM to TTS
  pipeline can run on Mistral alone (the [Voice loop](https://effect-uai.betalyra.com/recipes/voice-loop/)
  recipe selects it with `--provider=mistral`).

  See [Migrating to 0.9](https://effect-uai.betalyra.com/migrations/v0-9/).
