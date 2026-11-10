# @effect-uai/chat-completions

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

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

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

## 0.11.0

Initial release. A reusable OpenAI Chat Completions (`POST /chat/completions`)
`LanguageModel` base for `@effect-uai/core`: SSE streaming, tools, and
structured output over the legacy chat dialect. Point it at any compatible
endpoint with `baseUrl` (OpenRouter, Requesty, Groq, Together, self-hosted).

Prefer `@effect-uai/responses` when the endpoint speaks the Responses protocol;
this dialect exists for endpoints that do not.
