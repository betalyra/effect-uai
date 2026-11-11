---
name: effect-uai
description: Use when building AI agents and AI media workflows with effect-uai (Effect-based primitives for agent loops, tools, streaming, structured output, embeddings, retrieval, reranking, speech, realtime voice and camera sessions, messenger bots, browser chat UIs, music, image, and video generation). Covers design philosophy, core primitives, provider wiring, and a recipe library for retry, fallback, tool approval, RAG and hybrid retrieval, transcription, speech synthesis, voice loops, realtime voice agents, Telegram/Discord/Slack bots, music generation, image generation and editing, video generation, SSE/JSONL, and more.
license: MIT
---

# effect-uai

Low-level Effect primitives for building AI agents as ordinary programs.
The library does not own your control flow; it gives you the pieces and
gets out of the way.

## Design philosophy

Use this mental model when writing or recommending code:

1. **State is a record you own.** History is `ReadonlyArray<Items.HistoryItem>`.
   Add whatever else your app needs (turn index, budget, tenant id,
   pendingPrompts, ...). The library never inspects it.
2. **One turn is a `Stream<TurnEvent>`.** Text deltas, reasoning, tool
   calls, usage updates, and the terminal `TurnComplete` (carrying the
   assembled `Turn`) all flow through one typed stream.
3. **The loop is a pull-based combinator.** `loop((state) => Stream<Step<A, S>>)`
   threads state across iterations. Each body returns a stream that
   forwards values, then ends with `Loop.next(state)` to continue or
   `Loop.stop()` / `Loop.stop(state)` to exit.
4. **Tools are typed Effects (or Streams).** A `Tool` declares an input
   schema and a `run(input)` returning an Effect, or a Stream of snapshots
   of its own output type. Tools are grouped into a name-indexed `Toolkit`,
   and `Toolkit.run(toolkit, calls)` returns a stream of `ToolEvent.Partial`
   (every stream element, as it is produced) and `ToolEvent.Output` (a typed
   `Result`), so the UI sees progress while only the final value goes back
   to the model.
5. **Providers are Layers.** `LanguageModel` is a single service; each
   provider package (`@effect-uai/responses`, `@effect-uai/anthropic`,
   `@effect-uai/google`) ships a `layer({ apiKey })` that implements it.
   The program shape stays identical across providers.

When the user asks for a "framework feature" (auto-retry, mid-stream
abort, pause/resume, streaming JSONL, multi-model voting, ...), the
answer is almost always "compose primitives in the loop body", not
"reach for an integration." Recommend the appropriate recipe pattern
(see catalog below) instead of building wrapper layers.

## Install

```sh
pnpm add @effect-uai/core effect
# pick one or more providers:
pnpm add @effect-uai/openai            # OpenAI: Responses (language) + embeddings + speech + images
pnpm add @effect-uai/responses         # OpenAI Responses adapter alone (also for gateways)
pnpm add @effect-uai/chat-completions  # Legacy OpenAI-compatible /chat/completions base
pnpm add @effect-uai/anthropic         # Anthropic Claude
pnpm add @effect-uai/google            # Google Gemini language + embeddings + speech + music + images + video
pnpm add @effect-uai/fal               # Fal: FLUX, Seedream, Qwen Image, video models and the open-weights field
pnpm add @effect-uai/mistral           # Mistral language + Voxtral speech
pnpm add @effect-uai/jina              # Jina embeddings (text + image, sparse, multivector) + rerank
pnpm add @effect-uai/typesafe-ai       # TypeSafe AI Jev decision model (classify / rate / probability)
pnpm add @effect-uai/retrieval         # Chunking, rank fusion, Hugging Face tokenizer
pnpm add @effect-uai/elevenlabs        # ElevenLabs speech (TTS + STT, multi-speaker dialogue)
pnpm add @effect-uai/inworld           # Inworld speech (TTS + STT)
pnpm add @effect-uai/microsandbox      # Local Firecracker microVMs for sandboxed code
pnpm add @effect-uai/deno              # Hosted Firecracker microVMs on Deno Deploy
pnpm add @effect-uai/mcp               # MCP client: a server's tools as a Toolkit
pnpm add @effect-uai/telegram          # Messenger: run the agent as a Telegram bot
pnpm add @effect-uai/discord           # Messenger: run the agent as a Discord bot
pnpm add @effect-uai/slack             # Messenger: run the agent as a Slack bot
pnpm add @effect-uai/ui                # Agentic UI: stream runs to a browser as typed state
```

The core package has no provider dependencies. Edge / browser builds
only pull in what's actually used.

Beyond `LanguageModel`, the core ships parallel capability services, each
with its own provider layers and recipes in the library below:
`EmbeddingModel` (`embed` / `embedMany`, text + image, multivector),
`Reranker` (`rerank`: score a candidate set against a query, best first),
`DecisionModel` (`decide`: typed classify / rate / probability questions
about one input, a probability distribution per answer, one call),
`Chunker` and `Tokenizer` (implemented by `@effect-uai/retrieval`),
`Transcriber` (file + streaming STT), `SpeechSynthesizer` (finished +
incremental TTS, multi-speaker dialogue), `RealtimeSession` (a live
conversation with a realtime model: voice in and out, camera frames on
Gemini, tools mid-call), `MusicGenerator`,
`ImageGenerator` (`generate` / `edit`, plus marker-gated preview
streaming), `VideoGenerator` (an explicit background job: `submit`,
`status`, `cancel`, `read`), `Sandbox`
(run untrusted code in a microVM: `@effect-uai/microsandbox` local,
`@effect-uai/deno` hosted), and `Messenger` (the agent as a Telegram,
Discord or Slack bot: one inbound event stream, five outbound verbs, the
chat it answers in is ambient).

## Core modules (cheat sheet)

| Module                                  | What it gives you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@effect-uai/core/Items`                | `HistoryItem` types (user/assistant messages, tool calls, tool call outputs, reasoning), helpers like `Items.userText`, `Items.toolCallOutput(call_id, text)`, predicates `Items.isToolCall`, `Items.isToolCallOutput`. `ToolCallOutput.output` is an array of typed parts (`Items.text` / `json` / `image` / `file`) plus optional `isError`; read a value back with `ToolOutput.value(output)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `@effect-uai/core/Turn`                 | `Turn`, `TurnEvent`, `Turn.getToolCalls(turn)`, `Turn.assistantMessages(turn)`, `Turn.assistantText(turn)`, `Turn.assistantTexts(turn)`, `Turn.assistantImages(turn)`, `Turn.imagesAsInput(history)`, `Turn.appendToHistory(state, turn, items?)`, `Turn.decodeStructured(turn, format)`, `Turn.textDeltas`, `Turn.toSSE`, `Turn.toJSONL`, `Turn.asSSE`, `Turn.asJSONL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@effect-uai/core/LanguageModel`        | `LanguageModel` service tag, `streamTurn(request)`, `turn(request)`, `CommonRequest` type (`tools?` takes a `Toolkit` directly; the provider renders descriptors), `turnFromStream(streamTurn)` for hand-rolled services.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@effect-uai/core/Retry`                | `Retry.stream(schedule)`, `Retry.effect(schedule)`, `Retry.Retryable`, `Retry.isRetryable`. Retries the retryable subset of `AiError` (RateLimited \| Unavailable \| Timeout); works for any model service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@effect-uai/core/EmbeddingModel`       | `EmbeddingModel` service tag, `embed(request)`, `embedMany(request)`. `task: "query" \| "document"` matters for retrieval models; `dimensions` truncates Matryoshka embeddings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@effect-uai/core/Reranker`             | `Reranker` service tag, `rerank(request)`. Returns `{ index, score }` positions into the `documents` you sent, sorted descending. Scores are not calibrated and not comparable across calls: cut by rank (`topN`), never a fixed threshold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@effect-uai/core/Decision`             | `Decision.make({ inputSchema, decisions })` declared once at module scope; `Decision.classify` (named labels), `Decision.rate` (ordered rubric), `Decision.probability` (one statement). Answers are typed by the definition: `labels.<name>` is a compile error for an unknown label, `levels` is a tuple aligned with the echoed `legend`. Read with `winner`, `ranked`, `margin`, `confidence`, `topLevel`, `expectedLevel`. Gate on top probability and `margin`, never on `confidence`: normalised entropy shrinks with label count. Experimental.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@effect-uai/core/DecisionModel`        | `DecisionModel` service tag, `decide(definition, { model, input })`. Every decision in the definition is answered in one call and the input is billed once, so batch questions. Provider: `@effect-uai/typesafe-ai/Jev` (typed tag `Jev` adds the vendor's own `confidence`). Experimental.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@effect-uai/core/Chunker`              | `Chunker` service tag, `chunk(text)`, the `Chunk` type (`text` / `start` / `end`). `input.slice(start, end) === text` always holds. Implemented by `@effect-uai/retrieval/Chunking`, or a hosted chunking service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@effect-uai/core/Tokenizer`            | `Tokenizer` service tag: `encode` / `decode`. Count with `encode(text).length`. Implemented by `@effect-uai/retrieval/HuggingFaceTokenizer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@effect-uai/core/Vector`               | `Vector.cosine`, `dot`, `euclidean`, `normalize`, `sparseCosine`, `maxSim` (late interaction). Recipe-volume math, not a vector index.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@effect-uai/retrieval/Chunking`        | `recursive` (the default), `sentences`, `markdown`, `fixed`, all pure with provenance offsets; `Chunking.layer(chunker, options)` serves one through the core `Chunker` tag; `withTokenizer(chunker)` sizes by real tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@effect-uai/retrieval/Rank`            | `Rank.rrf(rankings, { k?, weights? })`: reciprocal rank fusion for combining retrievers on incomparable score scales (BM25 vs cosine). Fuse ids, not fresh objects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@effect-uai/core/Transcriber`          | `Transcriber` service tag, `transcribe(request)`, `streamTranscriptionFrom(request)`. Sync file STT and streaming mic STT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@effect-uai/core/SpeechSynthesizer`    | `SpeechSynthesizer` service tag, `synthesize`, `streamSynthesis`, `streamSynthesisFrom` for finished-text and incremental-text TTS. New in 0.6: `synthesizeDialogue`, `streamSynthesizeDialogue` (gated by the `MultiSpeakerTts` capability marker); `pronunciations` on `CommonSynthesizeRequest`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@effect-uai/core/RealtimeSession`      | `RealtimeSession` service tag, `open(request)` for one live session with a realtime model: push `RealtimeInput` (`Audio`, `Text`, `ToolResult`, `VideoFrame`, `PlaybackPosition`), consume `RealtimeEvent` (`ResponseStarted`, `AudioDelta`, `OutputTranscriptDelta`, `InputTranscript`, `ToolCall`, `ToolCallCancelled`, `Interrupted`, `ResponseDone`, `ResumptionHandle`, `SessionEnding`). No agent wrapper: tool execution, playback and reconnection are the caller's. `open` completes the handshake before it succeeds; a close never synthesizes a `ResponseDone` (mid-response it fails `IncompleteTurn`). `sendVideoFrame` needs the `RealtimeVideoInput` marker, which only `@effect-uai/google/GeminiLiveSession` ships; `@effect-uai/openai/OpenAIRealtimeSession` is audio only. Mock: `testing/MockRealtimeSession`; adapter-level fake socket: `testing/FakeWebSocket`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@effect-uai/core/VideoGenerator`       | `VideoGenerator` service tag: `submit` / `status` / `cancel` / `read` (one wire call each); `watch`, `collect`, `generate` (cancels on interrupt), `toStream`, `toBytes` over the tag; `VideoJobRef` schema for persisted refs. Sources in `@effect-uai/core/Video`: `url` (bearer link), `ref` (provider-held file), `base64`, `bytes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@effect-uai/core/MusicGenerator`       | `MusicGenerator` service tag, `generate`, `streamGeneration`, `streamGenerationFrom` for prompt-to-music workflows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@effect-uai/core/ImageGenerator`       | `ImageGenerator` service tag, `generate` (prompt in, images out) and `edit` (prompt plus reference images). Shape is `aspectRatio` + `resolution` (`"1K"` / `"2K"` / `"4K"`), never pixels: adapters derive dimensions, exact pixels live on the provider-typed request. `streamGeneration` / `streamEdit` yield `PartialImage` frames then one `Complete`, gated by the `ImageStreaming` marker so a non-previewing provider is a compile error. Results are `ImageSource`, the same type `input_image` takes, so a generated image feeds the next turn with no conversion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@effect-uai/core/Loop`                 | `loop`, `loopOver`, `loopWithState`, `value(a)`, `next(state)`, `stop()` / `stop(state)`, `onTurnComplete`. `Step<A, S>` is the event type. The v0.5 `nextAfter` / `stopAfter` / `stopWithAfter` / `stopEvent` / `nextAfterFold` helpers were removed in 0.6; compose with `Stream.concat` instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@effect-uai/core/Settle`               | `drainBurst(queue, settle)`: block for the first item, then keep taking while the next lands within `settle`; the window resets per arrival. The input side of a long-lived loop (agentic-loop and messenger-agent recipes). `settleBurst(stream, settle)` is the same over a stream, batching into arrays behind a bounded buffer; `onQuiet(stream, settle, emit)` passes elements straight through and emits an extra one once arrivals stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@effect-uai/core/Tool`                 | Three model-visible tool kinds (discriminated by `_tag`): `Tool.make` (local: `run(input)` returns an Effect, or a Stream whose elements are partials and whose last is also the result; `inputSchema` takes an Effect Schema or `Tool.fromStandardSchema(...)`; `run` and `outputSchema` are required (encoded side must be JSON: `Schema.DateFromString`, not `Schema.Date`; `Content.Value` for "anything"); optional `failureSchema` lists the errors the model may see, including the app's closings (`ToolDecision.Denied`), anything else fails `Toolkit.run`'s stream), `Tool.declare` (no `run`: the loop handles the call, a signal like escalate, or a call answered elsewhere typed by the optional `outputSchema`; see `Toolkit.split`), `Tool.provider` (provider-hosted). Plus `Tool.ToolFailed` / `Tool.fail(message)` (a ready-made error to list in `failureSchema`), `Tool.withFailures` (keeps the kind), `Tool.fromEffectSchema`, `Tool.toDescriptors`, `Tool.decodeArgs`, `Tool.withRun` (override/mock, or implement a declared tool; keeps the schemas), `Tool.withName`, `Tool.AnyTool`. A call to a declared tool, or a provider tool, passed to `Toolkit.run` yields `ToolOutput.UnknownTool`. `Tool.execute` is gone: `Toolkit.run(Toolkit.make(tool), [call])`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@effect-uai/core/Toolkit`              | A `Toolkit` is a name-indexed record of tools. `Toolkit.make(...tools)` (compile-time duplicate-name check) / `Toolkit.fromArray(tools)` (trusted dynamic source) index by name; pass the toolkit straight to `streamTurn({ tools: toolkit })` (it renders descriptors at the provider boundary; `Toolkit.descriptors(toolkit)` still exists if you want the array); `Toolkit.run(toolkit, calls)` executes locals only and streams `ToolEvent`s typed per tool. Combine independent toolkits with `Toolkit.compose(...kits)` (effectful; fails `DuplicateToolName` with source provenance, compile error for static clashes); prefix with `Toolkit.namespace(prefix, kit)` / `Toolkit.makeNamespaced`. Middleware via `Toolkit.wrap(mw)` (receives and returns `run` as a stream). `Toolkit.describeFailures(kit, describe)` turns undeclared errors into a model-visible `ToolFailed` (`describe` returns `undefined` to keep one fatal). Loop helpers: `Toolkit.next(toolkit, state, turn)` = `Toolkit.continueWith(Toolkit.appendResults(toolkit, state, turn))`; `continueWith(build)` forwards events, then continues with `build(outcomes)` (an Effect). `Toolkit.split(toolkit, turn)` (Effect of `{ run, declared, invalid }`: calls for `Toolkit.run`, calls to declared tools decoded and typed per tool (`Toolkit.DeclaredCall<T>`, handle with `Match.type<Toolkit.DeclaredCall<typeof toolkit>>().pipe(Match.discriminatorsExhaustive("tool")({...}))` so a new declared tool is a compile error), and declared calls with bad arguments closed with `InputInvalid`). `Toolkit.complete(toolkit, "tool", call, value)` answers a call with a value typed by `outputSchema` (success side of `Toolkit.close`). `Toolkit.isOutcome` (guard for `Output`, also on a loop's mixed stream), `Toolkit.output(toolkit, event)` (Effect of the history item), `Toolkit.decode(toolkit, name, item)` (history item back to a typed `Result`). |
| `@effect-uai/core/ToolEvent`            | `ToolEvent.Partial { call_id, tool, value }` (a Stream tool's intermediate value, typed as its output) and `ToolEvent.Output { call_id, tool, result }` (Effect `Result`: `Success` with the value, `Failure` with a declared or core error). `tool` is the discriminant: `e.tool === "search"` narrows `value` / `result`. Values are decoded (a `Date` stays a `Date`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@effect-uai/core/ToolOutput`           | Tool values to history parts: `ToolOutput.success(call, schema, value)` / `failure(call, schema, error)` (Effects of a `ToolCallOutput`; failure sets `isError`), low-level: prefer `Toolkit.close` / `Toolkit.complete`, which check against the tool's schemas, `make(call, value)` for a `Content.Value`, `value(parts)` to read parts back. Core errors (`CoreError` union): `InputInvalid`, `OutputInvalid`, `UnknownTool`, `Cancelled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@effect-uai/core/Content`              | The "anything" output type (`outputSchema: Content.Value`): `Content.Value` = string, JSON, `Content.Image`, `Content.File`, or a top-level array of JSON and media. Build media with `Content.image(source)` / `Content.file(source, filename?)` (e.g. `Content.image(imageBytes(png, "image/png"))` from `@effect-uai/core/Image`). Providers send media natively where supported; text-only tool channels (Chat Completions, Mistral, OpenAI Realtime) fail with `AiError.Unsupported`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@effect-uai/core/ToolDecision`         | Answers to waiting tool calls (approve, deny, edit, anything). `ToolDecision.make({ Approve: {...}, Deny: ToolDecision.closesWith(fields, build) })` defines an app's decisions (constructors + `schema` + `resolve`); `closesWith` marks an answer that ends the call with the error it builds. `ToolDecision.Default` is approve, or deny with an optional `reason` (ending in `ToolDecision.Denied`). `ToolDecision.Answer<D>` is `{ callId, decision }`. `Decisions.resolve(waiting, answers)` returns `answered` (tagged by decision, for an exhaustive `Match`), a group per tag, `unanswered` and `invalid`. `ToolDecision.byTool({ tool: set }, { fallback })` gives each tool its own set (same tag, same fields, else a compile error). Decisions are app code; a gated tool only lists its closings in `failureSchema`. Running approved calls and closing the rest (a queue wait, timeouts, an `ApprovalRequested` event) is app code: see the `tool-call-approval` recipe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@effect-uai/core/Sandbox`              | `SandboxService` capability for running untrusted code or LLM scripts in an isolated microVM. `create` / `exec` / `execStream`, plus `SandboxImage`, `SandboxNetwork`, `Memory`. Two providers: `@effect-uai/microsandbox` (local) and `@effect-uai/deno` (hosted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@effect-uai/core/Messenger`            | `Messenger` service tag: `events` (one `Stream<InboundEvent>`: `Message` with `addressed`, `Command`, `Reaction`, `Action`) plus `post` / `edit` / `react` / `typing` (scoped) / `stream` (progressive delivery). `Messenger.text(body, { replyTo? })`, `Messenger.media(source, { caption?, filename? })`, `Messenger.raw(payload)` build an `Outbound`; text is sent verbatim, prompt the model for the platform's markup. `post` / `typing` / `stream` target the ambient `CurrentConversation`: wrap a fiber once with `Messenger.inConversation(ref)`. `@effect-uai/core/MessengerAdapter` (`streamViaEdits`, `splitForLimit`) is the adapter author's side and never a recipe import. Providers: `@effect-uai/telegram` (long-poll, `parseMode: "HTML"` default), `@effect-uai/discord` (gateway websocket, markdown, no `Command` events) and `@effect-uai/slack` (Socket Mode, `botToken` + `appToken`, markdown, `replyIn: "thread"` default, mention required in threads). Mock: `testing/MockMessenger`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@effect-uai/core/HistoryCheck`         | `findUnansweredCalls`, `cancelAllPending(history, reason?)` (an Effect of ready-to-append outputs, a `ToolOutput.Cancelled` error each) for reconciling orphan tool calls between sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@effect-uai/core/StructuredFormat`     | `StructuredFormat.fromEffectSchema(schema)`, `StructuredFormat.parseJson`, `StructuredFormat.decodeJsonLines`, `decodeJsonLinesRecoverable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@effect-uai/core/SSE`                  | Server-Sent Events codec: `SSE.fromBytes`, `SSE.toBytes`, `SSE.Event`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@effect-uai/ui`                        | Browser chat UIs (wire protocol v2). Server: `Projection.toRunEvents({ contract })` (the contract encodes tool values; `contract.success(call, value)` / `contract.failure(call, error)` encode calls the app closes), then `Run.failed` (in `Stream.catchCause`), `Run.stopWhen`, `Run.start`, `Run.complete`, `Run.sequence`, `SseEncoding.encode` (plus `SseEncoding.heartbeat` for idle session streams). Client: `Transport.direct` / `sessionHttp` (wrap durable ones in `Transport.reconnect`, which resumes from the last seq and retries only transient errors), `Atoms.thread` / `sessionThread` (runtime provides `HttpClient` + `SecureRandom`; `open({ streamId, after })` + `initial` for a thread hydrated from a database), state is a `Thread` of `RunView`s; the folds are pure, so FoldKit or a reducer can run them. `UiContract.make({ tools })` from shared Schema specs (`as const`) types tool blocks in the browser: a block has `partial?` and `outcome?` (`Success { value }` / `Failure { error }`, errors decoded back to their classes from each tool's `failureSchema`, app closings like `ToolDecision.Denied` included, and `ToolOutput.CoreError`). Approval answers: `Input.resolve([{ callId, decision: ToolDecision.Default.Approve() }])`. History stays on the server; the client sends only the new message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@effect-uai/core/JSONL`                | JSONL codec: `JSONL.fromBytes`, `JSONL.parse(schema)`, `JSONL.toBytes(schema)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@effect-uai/core/Lines`                | `Lines.lines` for re-framing a string stream as newline-terminated lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `effect/Match`                          | `Match.discriminators("_tag")({ TextDelta, ... })` for `TurnEvent` / `ToolEvent` (both `_tag`-tagged; `TurnEvent` via `Data.taggedEnum`, so also `TurnEvent.$is(...)` / `TurnEvent.$match(...)`). `Match.discriminators("type")` for domain `HistoryItem` types and provider wire shapes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@effect-uai/core/testing/MockProvider` | `MockProvider.layer(scriptedTurns)`, `MockProvider.layerWithRecorder`, `MockProvider.make` for tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Provider wiring

Every provider package exports a namespaced `layer({ apiKey, ... })`
that implements the generic `LanguageModel` service. The standard
wiring pattern:

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const mainLayer = apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer))

Effect.runPromise(program.pipe(Effect.provide(mainLayer)))
```

For Anthropic: `import { layer as anthropicLayer } from "@effect-uai/anthropic/Anthropic"` + `ANTHROPIC_API_KEY`.
For Gemini: `import { layer as geminiLayer } from "@effect-uai/google/Gemini"` + `GOOGLE_API_KEY`.
For Mistral: `import { layer as mistralLayer } from "@effect-uai/mistral/Mistral"` + `MISTRAL_API_KEY`.

Each provider also re-exports a typed service tag (`Responses`,
`Anthropic`, `Gemini`, `Mistral`) for code that wants the provider-specific
request shape (e.g. `reasoning: { effort: "low" }` on Responses).
For provider-agnostic code, use the generic `LanguageModel` service.

Image layers follow the same shape under the `ImageGenerator` tag:
`@effect-uai/openai/OpenAIImageGenerator` (`gpt-image-2`, the only one
that streams previews, so the only one registering `ImageStreaming`),
`@effect-uai/google/GeminiImageGenerator` (Nano Banana 2), and
`@effect-uai/fal/FalImageGenerator` + `FAL_API_KEY`. On Fal the model id
is an endpoint path copied from the model's page, and generating and
editing are separate endpoints.

Video layers follow it under the `VideoGenerator` tag:
`@effect-uai/google/GeminiOmniVideoGenerator` (`gemini-omni-1.2-flash`)
and `@effect-uai/fal/FalVideoGenerator` (any Fal video endpoint by path,
per-endpoint fields through `wire`). Generation is a job you drive:
`submit` returns a `VideoJobRef` (plain data; persist it, decode it back
with the `VideoJobRef` schema, `collect` it from another process),
`watch` streams every polled state, `collect` polls to the result, and
`generate` is submit plus collect, cancelling on interrupt. Read a clip
with `VideoGenerator.toStream(video)` / `toBytes(video)`: it goes
through the provider that produced it, which matters for a `ref` source
(a file only that provider can read; Omni's default) and keeps API keys
away from URLs. A `url` source is a bearer link that expires; copy
anything you keep into your own storage. `inputs` are role-tagged:
`VideoInput.FirstFrame` / `LastFrame` / `ReferenceImage` /
`ReferenceVideo`.

Google's image models double as `LanguageModel` models: give
`Gemini.turn` an id like `gemini-3.1-flash-image` and the answer comes
back with `output_image` blocks among its content, editable by replaying
the history. `Turn.assistantImages(turn)` reads them;
`Turn.imagesAsInput(history)` restates them as `input_image` when the
next model has no assistant-image wire (every provider but Gemini, which
drop the block on replay and log a capability warning).

`@effect-uai/mcp` is the exception to the layer pattern: an MCP server
supplies tools, not a capability, so it is a scoped resource rather than a
`layer({ apiKey })`. `connect(config)` returns
`Effect<McpClient, McpError, Scope>` and `mcpToolkit(client, { prefix })`
turns the server's tools into an ordinary `Toolkit` you compose and run
like any other. `Effect.scoped` / `Stream.scoped` / `layer(config)` all
close the connection; there is no `close()`. HTTP transport needs an
`HttpClient`, stdio needs a `ChildProcessSpawner`. See `mcp-tools`.

Messenger layers connect on build and disconnect with their scope, so
they need `Effect.scoped` around the program and an `HttpClient`:
`telegramLayer({ token })`, `discordLayer({ token, intents? })`,
`slackLayer({ botToken, appToken, replyIn? })`. Each registers both the
generic `Messenger` tag and its own typed tag (`Telegram`, `Discord`,
`Slack`). A refused token is `MessengerConnectFailed` at wiring time. The
model must be prompted for the platform's markup (Telegram HTML, markdown
on Discord and Slack); nothing converts.

OpenAI-compatible gateways (OpenRouter, Requesty) are not separate
providers. Point a protocol adapter at the gateway's `baseUrl`: prefer
`@effect-uai/responses` (the modern Responses protocol, which both
gateways support); drop to the legacy `@effect-uai/chat-completions` base
only for a model served solely over `/chat/completions`.

## One turn is a stream

The smallest example: stream one model response and print text deltas.

```ts
import { Effect, Match, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"

const program = Stream.runForEach(
  streamTurn({
    history: [Items.userText("Write a haiku about the sea.")],
    model: "gpt-5.4-mini",
  }),
  (event) =>
    Match.value(event).pipe(
      Match.discriminators("_tag")({
        TextDelta: ({ text }) => Effect.sync(() => process.stdout.write(text)),
      }),
      Match.orElse(() => Effect.void),
    ),
)
```

The terminal `TurnComplete` event carries the assembled `Turn`, which
is what tool-using loops, structured-output validation, and history
appends are built on.

## The canonical agent loop

Almost every recipe is a variation of this shape:

```ts
import { Effect, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { Responses } from "@effect-uai/responses/Responses"

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
}

const initial: State = {
  history: [Items.userText("What time is it in Lisbon?")],
}

const toolkit = Toolkit.make(/* getCurrentTime, ... */)

export const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses
      return oai.streamTurn({ history: state.history, model: "gpt-5.4-mini", tools: toolkit }).pipe(
        onTurnComplete((turn) => {
          const calls = Turn.getToolCalls(turn)

          // No tool calls: assistant is done.
          if (calls.length === 0) return stop()

          // Tool calls: execute, append outputs, loop again.
          return Toolkit.run(toolkit, calls).pipe(Toolkit.next(toolkit, state, turn))
        }),
      )
    }),
  ),
)
```

Read the body in plain English: "stream a turn. When it completes, if
the model asked for tools, run them and continue with the appended
history. Otherwise, stop." Every variation in the recipe catalog is a
small change to this body.

`Turn.appendToHistory(state, turn, items)` is the canonical way to advance
state. It returns `{ ...state, history: [...state.history, ...turn.items, ...items] }`.
`Toolkit.next(toolkit, state, turn)` forwards every tool event, then
encodes each outcome with the tool's schemas (`Toolkit.output`) and folds
the outputs in. For a custom state, use the halves:
`Toolkit.continueWith((outcomes) => Toolkit.appendResults(toolkit, { ...state, trail: trailOf(outcomes) }, turn)(outcomes))`.
Without the loop helpers: `Toolkit.run(...).pipe(Stream.filter(Toolkit.isOutcome), Stream.mapEffect(Toolkit.output(toolkit)), Stream.runCollect)`.

## Defining tools

```ts
import { Effect, Schema, Stream } from "effect"
import * as Tool from "@effect-uai/core/Tool"

class CityNotFound extends Schema.TaggedError<CityNotFound>()("CityNotFound", {
  city: Schema.String,
}) {}

// Effect tool: outputSchema types what run returns (Content.Value for "anything").
// Declared failures reach the model; any other error fails Toolkit.run's stream.
const weather = Tool.make({
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ city: Schema.String, tempC: Schema.Number }),
  failureSchema: CityNotFound,
  run: ({ city }) =>
    Effect.gen(function* () {
      if (city !== "Lisbon") return yield* new CityNotFound({ city })
      return { city, tempC: 21 }
    }),
})

// Stream tool: every element is a ToolEvent.Partial for the UI as it arrives;
// the last is also the result the model sees. Progress is part of the output type.
const download = Tool.make({
  name: "download",
  description: "Download a file.",
  inputSchema: Schema.Struct({ url: Schema.String }),
  outputSchema: Schema.Struct({ pct: Schema.Number, done: Schema.Boolean }),
  run: () => Stream.make(25, 50, 75, 100).pipe(Stream.map((pct) => ({ pct, done: pct === 100 }))),
})
```

Consumers narrow tool events by name: `e._tag === "Partial" && e.tool === "download"`
types `e.value`; an `Output`'s `result` is an Effect `Result` (check
`result._tag` on a union, or narrow by `tool` first).

## Designing your loop body

When asked to add behavior, prefer adding to the loop body over
introducing wrapper services. The patterns below all live in one
`Effect.gen` block in the body, with no API surface change:

- **Persist state** between turns: write `state` to your DB at the top
  of each iteration. The library never inspects state.
- **Inject system policies**: group gated calls with
  `ToolDecision.Default.resolve(waiting, answers)` (or the `tool-call-approval`
  recipe's `fromQueue`) before `Toolkit.run`; close denied / unanswered calls
  with typed `ToolDecision.Denied` / `ToolOutput.Cancelled` failures.
- **Compact history**: when `state.history` exceeds a budget, run a
  separate `streamTurn` that summarizes earlier items, then return
  `Loop.next(withSummary(state))`.
- **Track usage**: each `turn.usage` field is plain data; accumulate
  on state and emit your own metrics.
- **Branch on model output**: inspect `turn.items` (tool calls,
  reasoning, refusals) before deciding what to do.
- **Add retries**: wrap `streamTurn` with `Retry.stream(schedule)` (or
  `Stream.retry`); see the model-retry recipe for tag-aware retry.
- **Multi-provider**: the body can choose which `LanguageModel` to use
  per iteration (e.g. for fallback / consensus).
- **Run untrusted code**: yield a `SandboxService` inside the body,
  `create` a microVM, `exec` the script, and feed `stderr` back into
  the next turn. See the `sandbox-code-interpreter` recipe.

## Recipe library

The recipes are the reference implementations, each a small variation on
the loop body above (or on the parallel capability services). They live
in `recipes/<name>/` in the repo and, rendered, at
`https://effect-uai.com/recipes/<name>/`. The set grows over
time, so treat the docs recipes index as the source of truth rather than
this table.

**How to use one.** When a scenario matches, open the recipe and adapt it:
`README.md` is the walkthrough (when to reach for it, the loop body, the
gotchas); `recipe.ts` / `index.ts` is the runnable core; `app.ts` /
`run-*.ts` wire a provider and runtime. Working outside the repo? Fetch
the recipe's page from the docs site.

Common scenarios and where to start:

| Scenario                                                             | Recipe                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| First agent: tools, streaming, multi-turn loop                       | `basic-usage`                                                      |
| Typed JSON object back from the model (one-shot)                     | `structured-output`                                                |
| Stream typed JSONL objects as the model writes them                  | `streaming-structured-output`                                      |
| Human approval before sensitive tool calls                           | `tool-call-approval`                                               |
| Show inner tool work while returning one clean output                | `streaming-tool-output`                                            |
| Long-lived chat from a debounced input queue                         | `agentic-loop`                                                     |
| The agent as a Telegram, Discord or Slack bot, one loop per chat     | `messenger-agent`                                                  |
| Retry rate-limited / transient failures with backoff                 | `model-retry`                                                      |
| Fall back to another provider on retryable errors                    | `multi-model-fallback`                                             |
| Cheap model escalates hard questions to a stronger one               | `model-escalation`                                                 |
| Summarize history when it exceeds a budget                           | `auto-compaction`                                                  |
| Pause the loop between turns and resume later                        | `pause-resume`                                                     |
| Cancel an in-flight turn cleanly                                     | `mid-stream-abort`                                                 |
| Fan one prompt to N providers; tag each delta                        | `multi-model-compare`                                              |
| Models judge each other and emit a winner                            | `model-council`                                                    |
| Chat page: one request per message, server keeps history             | `direct-chat`                                                      |
| Chat that survives reloads, queues messages, has Stop                | `durable-chat`                                                     |
| Project loop output as SSE / JSONL on the wire                       | `modify-output-stream`                                             |
| Emit token / latency / cost metrics                                  | `basic-metrics`                                                    |
| Grounded answer over live web search                                 | `grounded-answer`                                                  |
| Long-running background research to a cited report                   | `deep-research`, `native-deep-research`                            |
| Embed text or images; semantic / cross-modal / multivector retrieval | `basic-embedding`, `multimodal-embedding`, `multivector-embedding` |
| Top results are related but do not answer; re-score a shortlist      | `retrieve-and-rerank`                                              |
| Keyword and vector retrieval fused, as a tool the agent re-calls     | `agentic-search` (extras)                                          |
| Chunks lose their referents; situate each one at index time          | `contextual-retrieval` (extras)                                    |
| Route / prioritise / flag an input with typed questions, no prose    | `ticket-triage`                                                    |
| Transcribe finished audio, or live mic captions                      | `basic-transcription`, `streaming-transcription`                   |
| Text to audio file, or incremental LLM deltas to TTS                 | `basic-speech-synthesis`, `streaming-synthesis`                    |
| Voice assistant: live STT to LLM to streaming TTS                    | `voice-loop`                                                       |
| Voice assistant on a realtime model: barge-in, tools mid-call        | `realtime-voice-agent`                                             |
| Voice assistant that sees: camera frames on the same session         | `camera-assistant`                                                 |
| Generate music clips, or a continuous stream                         | `basic-music-generation`, `radio-station`                          |
| Generate a video clip, persist the job, resume an interrupted render | `basic-video-generation`                                           |
| Many images that keep one cast consistent across them                | `storyboard`                                                       |
| Refine one image over several turns without losing the subject       | `conversational-image-edit`                                        |
| Run untrusted / LLM-generated code in a microVM                      | `sandbox-code-interpreter`                                         |
| Drive a headless browser as a tool                                   | `browser-usability`                                                |
| Use an MCP server's tools in the loop                                | `mcp-tools`                                                        |

More recipes exist than are listed here (check the docs recipes index).
When more than one applies (e.g. "agentic chat that retries on rate limits
and falls back to another provider"), compose them: the loop body is just
an Effect, and Effect composition is the integration mechanism.

## Common gotchas

1. **Stream events vs. Turn items.** `TurnEvent` is the streaming
   delta union; `Turn.items` is the assembled list on `TurnComplete`.
   Tool calls live on `Turn.items`, not as standalone events. Use
   `Turn.getToolCalls(turn)` once the turn completes.
2. **Tool call outputs must be appended.** Every `ToolCall` the model
   emits requires a matching `ToolCallOutput` in history before the
   next turn. `Toolkit.run` + `Toolkit.next(toolkit, state, turn)` does
   this correctly. When you don't run a tool, close it with a typed error:
   `yield* Toolkit.close(toolkit, call, error)`, where `error` is core's
   `ToolOutput.Cancelled` or one the tool declares (a gated tool lists
   `ToolDecision.Denied` in its `failureSchema`, or use `Tool.withFailures`);
   otherwise it fails with `UndeclaredFailure`.
   `Toolkit.next` then encodes it like any other outcome. Orphans from an
   earlier session: `yield* HistoryCheck.cancelAllPending(history)`.
3. **Source-level vs. wire-format naming (0.6 only matters at the source).**
   v0.6 renamed every public name from "function call" to "tool call"
   (`Items.FunctionCall` -> `Items.ToolCall`, etc.). The wire format
   is unchanged: providers still send `function_call` and
   `function_call_output` payloads. You only need to update imports
   and identifiers; no payload migration.
4. **`Stream.retry` retries on every failure.** To retry only the
   retryable `AiError` subset (`RateLimited` / `Unavailable` / `Timeout`),
   use `Retry.stream(schedule)` / `Retry.effect(schedule)` from
   `@effect-uai/core/Retry` (see the `model-retry` recipe). Plain
   `Stream.retry` will retry non-retryable errors too.
5. **Top-level structured output schema must be `type: object`.** All
   providers reject bare arrays at the wire; wrap arrays in a
   `{ items: [...] }` object.
6. **Provider-specific options** (Responses `reasoning`, Anthropic
   `system` blocks, Gemini `safetySettings`) belong on the typed
   provider tag's request, not on `CommonRequest`. Yield the typed
   service (`yield* Responses`) when you need them.
7. **Tool input schemas need `type: object`.** A bare `Schema.Struct({})`
   serializes to no schema; the OpenAI Responses API rejects it. Add at
   least one field, or pick a different parameter shape.
8. **`Loop.stop` is a function in 0.6.** Return `stop()` for "end the
   loop", `stop(state)` for "end and surface final state". The v0.5
   bare `stop` constant and `stopWith(state)` helper are gone.
9. **The loop never stops itself by default.** Long-lived agents (chat,
   queues, websocket-driven loops) terminate by external interruption
   (Ctrl-C, `Fiber.interrupt`, scope close). Don't add bespoke
   self-termination unless you mean it.
10. **Sandboxes are scope-bound.** Wrap `Sandbox.create(...)` in
    `Effect.scoped` (or compose into a `Scope`d effect) so the microVM
    is torn down on completion or interruption. Leaking sandboxes
    means leaking billable infra on hosted providers.
11. **Ask for images by ratio and tier, not pixels.** `aspectRatio` +
    `resolution` port across providers; a hardcoded `"1536x1024"`
    becomes the wrong crop when you switch. Exact pixels go on the
    provider-typed request.
12. **An image model may answer with no text.** These models often put
    everything, words included, in the picture. Code that reads
    `Turn.assistantText` and stops when it is empty will miss the
    answer; read `Turn.assistantImages` too.
13. **`ContentBlock` and `TurnEvent` gained members in 0.13**
    (`output_image`, `ImageOutput`). Exhaustive matches over either
    need a new arm.
14. **A tool needs at least one input field.** `Schema.Struct({})`
    becomes the JSON Schema `{"not":{"type":"null"}}`, which OpenAI
    rejects as `InvalidRequest`. Give the tool a real parameter.
15. **Undeclared tool errors are fatal.** Only errors in a tool's
    `failureSchema` reach the model; anything else fails `Toolkit.run`'s
    stream. Wrap with `Toolkit.describeFailures(kit, describe)` to show
    them to the model instead.
16. **Tool values must encode to JSON.** A tool with `run` requires
    `outputSchema`, and its encoded side must be JSON
    (`Schema.DateFromString`, not `Schema.Date`). `Content.Value` is the
    explicit "anything" (text, JSON, media).

## Testing

Use `MockProvider.layer(scriptedTurns)` to drive a loop without hitting
a real provider:

```ts
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"

const finalTurn: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ok" }],
    },
  ],
}

await Effect.runPromise(
  Stream.runCollect(conversation).pipe(Effect.provide(MockProvider.layer([finalTurn]))),
)
```

`MockProvider.layerWithRecorder` returns a layer + a recorder that
captures every `streamTurn` request, useful for asserting the model
saw the history you expected.

## Where to read more

- Repo: https://github.com/betalyra/effect-uai
- Docs: https://effect-uai.com (or `docs/` in the repo)
- Recipes: `recipes/<name>/` in the repo, one folder per pattern; also
  rendered at https://effect-uai.com/recipes/.
- Migrations: `docs/migrations/` (per-version upgrade notes).
- Language models: `docs/language-models/index.md`,
  `docs/language-models/items-and-turns.md`, `docs/language-models/loop.md`,
  `docs/language-models/tools.md`, `docs/language-models/tokenizers.md`.
- Retrieval: `docs/retrieval/index.md`, `docs/retrieval/chunking.md`,
  `docs/reranking/index.md`.
- Agentic UI: `docs/agentic-ui/index.md`; `packages/ui/README.md`. Per
  framework: `docs/agentic-ui/{nextjs,tanstack-start,foldkit}.md`, with
  runnable apps in `examples/next-chat` (`useChat` and `@effect-uai/ui` side
  by side), `examples/tanstack-start-chat`, `examples/foldkit-chat`.
- Decision models: `docs/decisions/index.md`,
  `docs/decisions/providers/typesafe-ai.md`.
- Images: `docs/image-generation/index.md` and
  `docs/image-generation/providers/`; for images inside a chat turn,
  `docs/language-models/images-in-turns.md`.
- Video: `docs/video-generation/index.md` and
  `docs/video-generation/providers/`.
