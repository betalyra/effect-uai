# @effect-uai/mcp

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

## 0.13.0

### Minor Changes

- 8abb609: New `@effect-uai/mcp`, a Model Context Protocol client. Point it at a server and
  its tools become a `Toolkit` the loop runs like any other, so an MCP tool and a
  local one are the same thing to your agent.

  ```ts
  import * as Client from "@effect-uai/mcp/Client"
  import { mcpToolkit } from "@effect-uai/mcp/Toolkit"

  const program = Effect.gen(function* () {
    const client = yield* Client.connect({ transport: "http", url: "https://mcp.deepwiki.com/mcp" })
    const toolkit = yield* mcpToolkit(client)
    return yield* streamTurn({ history, model, tools: toolkit })
  })
  ```

  - **Both transports.** `http` for hosted servers, `stdio` for a local process.
  - **Protocol era detected, not configured.** Servers span three revisions
    (`2025-06-18`, `2025-11-25`, `2026-07-28`), split across a handshake era and
    a stateless one. `connect` probes once per connection and caches the result;
    pin it with `protocol` to skip detection.
  - **Auth as a seam.** `Auth.Static` for a fixed token, `Auth.TokenSource` to
    re-read before every request, `Auth.OAuth` for built-in OAuth 2.1. Tokens
    stay `Redacted` until the wire boundary.
  - **Server-owned validation.** The input schema is a passthrough carrying the
    server's JSON Schema verbatim, so the model sees the real thing rather than a
    re-derived approximation.
  - **`Toolkit` composition.** `mcpToolkit(client, { prefix })` namespaces tools
    as `<prefix>__<name>`, so several servers combine without collisions.

  Connection lifetime is scope lifetime: `Client.layer` closes the transport when
  the scope closes. See [MCP](https://effect-uai.betalyra.com/language-models/mcp/)
  and the [MCP tools recipe](https://effect-uai.betalyra.com/recipes/mcp-tools/).

  See [Migrating to 0.13](https://effect-uai.betalyra.com/migrations/v0-13/).
