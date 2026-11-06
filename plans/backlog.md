# Backlog: open server-side and library items

Status: living to-do list (started 2026-11-06). One place for open items that
were scattered across plan follow-up sections, plus server-side gaps found
while designing `@effect-uai/ui` (`plans/ui.md`). Every item was checked
against the code at HEAD (dev, 494a909): "open" means the symbol, module or
recipe was not found. Frontend work lives in `plans/ui.md`, not here. Later,
items graduate into GitHub issues.

Done and dropped items are listed at the end so they don't get re-proposed.

## Core

### From the UI design (`plans/ui.md`)

- [ ] **Partial JSON streaming (`StructuredFormat.decodePartial(format)`)**:
      `Stream<string>` → partial (deep-partial, unvalidated) | done (validated),
      so one JSON value can be shown while it streams. Use a small existing
      tolerant-parser library, not a hand-rolled scanner (Effect 4.1 has none).
      Enables three things the UI v1 does without: progressive rendering of one
      large object (AI SDK `streamObject`), streaming lists under strict
      structured output (a JSON Schema allows only one document, so lists become
      `{"items":[…]}`), and live tool-argument previews. The UI protocol already
      has `object-delta` and `tool-call-args-delta`, so it is additive. Not urgent.
      Evidence: only `decodeJsonLines` / `decodeJsonLinesRecoverable` exist
      (`structured-format/StructuredFormat.ts:159-172`).
- [ ] **AbortSignal → interruption helper** (`interruptOnAbort(signal)`):
      `examples/ai-sdk-next` and the `mid-stream-abort` recipe each roll their own.
      Planned as `@effect-uai/ui/Run`; move to core if non-UI callers want it.
      Evidence: no `AbortSignal` handling in `packages/core/src`.
- [ ] **Speakable-chunk operator for streaming TTS input**: regroup LLM text
      deltas at clause or word boundaries before a streaming synthesizer, so word
      fragments don't cause audible cuts (the `/stream-input` style adapters
      terminate every frame). Real pipeline apps hand-roll it. Evidence: nothing in
      `packages/core/src`.
- [ ] **Alignment events on `SpeechSynthesizer` streams**: character or word
      timings where providers return them, so clients can sync text to played
      audio instead of estimating from a speaking rate. Evidence: no `alignment`
      in core or providers.
- [ ] **Realtime tool fork/cancel helper**: run each `ToolCall` in its own
      fiber, interrupt on `ToolCallCancelled`. ~75 near-identical lines in
      `realtime-voice-agent` and `camera-assistant`. Evidence: `ToolCallCancelled`
      exists only as an event (`domain/Realtime.ts:67`).
- [ ] **Document transcript partial semantics**: `TranscriptEvent` partials
      are snapshots, realtime input-transcript partials are deltas; consumers
      (voice-loop vs realtime recipes) treat them differently. Decide whether to
      align or to document per stream.

### Content types (researched 2026-11-06 against Open Responses, OpenAI, Anthropic, Gemini)

Rule: a shared core type only for what the major providers actually share;
everything else stays provider-typed.

- [x] **`input_file`** (in progress, `plans/ui.md` step 1): one block for
      documents, audio and video, the MIME type says which. Gemini already models
      every medium this way (`inlineData` / `fileData`); Open Responses has
      `input_file { filename, file_data, file_url }`. Codecs route by MIME prefix
      with a fixed table (chat-completions: `audio/*` → `input_audio`; OpenRouter:
      `video/*` → `input_video`; else the provider's file part). `input_image`
      stays: every provider has it and it carries image-only options.
- [ ] **Tool outputs with media**: `ToolCallOutput.output` is a string today.
      Shared by three: OpenAI Responses (`function_call_output.output` = string or
      `input_text` / `input_image` / `input_file` blocks), Anthropic
      (`tool_result.content` with `image` / `document` blocks), Gemini 3+
      (`functionResponse.parts`, images and PDF / text). Not Chat Completions
      (tool messages are text only; the usual workaround is a follow-up user
      message, the codec's call). Shape: `output: string | ReadonlyArray<InputText
| InputImage | InputFile>`; `Tool.make` lets a tool return content blocks.
      Highest value of this list (screenshots, charts, rendered pages).
- [ ] **File references** (`FileRef`, already noted in `Media.ts`): a
      provider-stored file by id instead of bytes or URL (OpenAI `file_id`,
      Anthropic file ids, Gemini Files API URIs, needed for large video). A
      fourth `MediaSource` variant `{ _tag: "ref", provider, id }`; a codec takes
      only its own provider's refs.
- [ ] **Compaction**: both OpenAI (Responses `context_management` compaction,
      automatic or `/responses/compact`; encrypted opaque `compaction` item) and
      Anthropic (`compact_20260112` beta; readable summary block, custom
      instructions) offer server-side compaction; Gemini does not. Shapes differ
      (opaque vs readable), so: a request option per provider plus the item kept
      as `providerData` round-trip, not a shared core item, until the shapes
      converge. Our `auto-compaction` recipe stays the portable path.
- [ ] **Full reasoning text**: only open-weight providers return it
      (DeepSeek, Qwen, Kimi `reasoning_content`; DeepSeek requires it back on tool
      turns). OpenAI, Anthropic and Gemini return summaries or nothing. Check how
      the chat-completions codec carries `reasoning_content` today (summary? or
      `providerData`); no new core field unless that round-trip is broken.
- Ignored for now: `detail` on `input_image`, output audio outside realtime,
  `logprobs`.

### From earlier plans

- [ ] **`Loop.loopFrom`**: loop seeded by a `Stream<I>`, usable as a stream
      operator. Source: `internal-docs/roadmap-from-assessments.md:44` (§ at :641).
- [ ] **Widen `LoopBody` to allow `Scope`** in the Effect-returning variant,
      so bodies don't need `Stream.unwrap`. Source: `plans/messenger.md` (~895).
      Evidence: `loop/Loop.ts:218`.
- [ ] **Provider-portable prompt-cache marker**: one canonical "cacheable
      prefix" marker each codec maps to its native control. Source:
      roadmap:45 (§ at :1175). Evidence: only Anthropic's config-level
      `cacheControl` (`anthropic/src/Anthropic.ts:165`).
- [ ] **`Embedding.asFloat32` / `embedFloat32`**: typed accessor in core; a
      local copy lives in `recipes/multimodal-embedding/recipe.ts:96`. Source:
      roadmap:41.
- [ ] **`isFailure` on `ToolCallOutput`**, mapped to Anthropic's native
      `is_error`. Source: `plans/tool-refactoring2.md:250`. Evidence:
      `domain/Items.ts:162`.
- [ ] **Multimodal tool-call output**: `ToolCallOutput.output` is a string
      only; MCP rich content depends on this. Source: `plans/mcp.md:153`.
- [ ] **`Turn.imagesAsInput` → per-item, renamed (e.g. `mediaAsInput`)**.
      Source: `plans/image-generation.md` (~506). Evidence: `domain/Turn.ts:152`.
- [ ] **Tests for `imagesAsInput` and `Capabilities.warnDroppedBlocks`**.
      Source: `plans/image-generation.md`.
- [ ] **Music continuation** (`reference?: AudioSource` on the request).
      Source: `plans/music.md:27`.

## Providers

- [ ] **Slack: thread follow-ups without a mention, reactions in threads**
      (needs a `conversations.replies(limit: 1)` lookup). Source:
      `plans/messenger.md:852`, `:864`.
- [ ] **Slack native streaming** (`chat.startStream` / `appendStream` /
      `stopStream`) instead of `streamViaEdits` (`Slack.ts:401`). Source:
      `plans/messenger.md` (~859).
- [ ] **Discord slash commands** (interaction type 2 is ignored today,
      `events.test.ts:86`). Source: `plans/messenger.md` (~881).
- [ ] **Discord header-driven rate-limit buckets** (`X-RateLimit-Bucket`;
      only `retry_after` on 429 today). Source: `plans/messenger.md` (~887).
- [ ] **Inbound `Message.media` and `Message.authorName`**
      (`messenger/Messenger.ts:62-70`). Source: `plans/messenger.md` (~890, ~895).
- [ ] **ElevenLabs `/v1/music/detailed`** (lyrics, sections). Source:
      `plans/elevenlabs-music.md:327`.
- [ ] **Responses `image_generation` hosted tool** (only an error string
      mentions it, `responses/src/Responses.ts:338`). Source:
      `plans/image-generation.md`.
- [ ] **WebSocket adapters onto `WebSocketSession.open`**: done for the
      OpenAI and Google realtime sessions; STT/TTS adapters (ElevenLabs, Inworld,
      Mistral, OpenAI realtime STT) and the Discord gateway / Slack socket still
      hand-roll it. Source: `plans/realtime.md:402`.
- [ ] **Decision: fal reference-field discovery** learns the field name from
      a 422 (`fal/src/codec.ts:104`), against the "no runtime guesswork" rule.
      Needs a decision (encoding table vs keep), not just code.
- [ ] **Verify: Gemini image 4K `inlineData` splitting** (live check; `n > 1`
      is intentionally `Unsupported`, `GeminiImageGenerator.ts:146`).

## MCP

Next up after the UI plan; needs its own plan (`plans/mcp-server.md` or an
update of `plans/mcp.md`). `@effect-uai/mcp` is client-only today.

- [ ] **MCP server support**: expose effect-uai tools (`Tool` / `Toolkit`,
      including the planned `outputSchema` as MCP `outputSchema` and
      `structuredContent`) and resources from an effect-uai app as an MCP server
      (HTTP transport, the 2026-07-28 stateless protocol the client already
      speaks). Open question for that plan: same package as the client
      (`@effect-uai/mcp` with `Client` / `Server` modules) or a separate
      `@effect-uai/mcp-server`.
- [ ] **MCP Apps, server side**: let effect-uai MCP servers ship tool UIs
      (`_meta.ui.resourceUri`, `ui://` resources with CSP metadata, app-only tools
      via `visibility: ["app"]`), so they render inside ChatGPT, Claude and other
      hosts.
- [ ] **MCP Apps, host side**: negotiate `io.modelcontextprotocol/ui` in the
      client, read `_meta.ui` on tool descriptors, hide app-only tools from the
      model, fetch `ui://` resources, carry a `{ server, resourceUri }` reference
      on tool results, proxy app-initiated tool calls behind an approval hook.
      Evidence: resource blocks are placeholder-summarized
      (`mcp/src/internal/schema.ts:148`).
- [ ] **MCP Apps browser bridge placement**: the sandboxed iframe +
      `postMessage` `ui/*` bridge is browser-only and builds on `@effect-uai/ui`
      transports and inputs (lean: a module in `@effect-uai/ui`), while the
      protocol work above stays in the MCP package. The protocol field is already
      reserved in `plans/ui.md`.
- [ ] **Rich content blocks in MCP tool results** (only `structuredContent`
      or text today, `mcp/src/Toolkit.ts:50`). Depends on multimodal tool output.
      Source: `plans/mcp.md:153`.
- [ ] **Interactive OAuth** (`authorizationCode`, PKCE, dynamic client
      registration); only `clientCredentials` today (`mcp/src/internal/auth.ts`).
      Source: `plans/mcp.md:148`.

## Realtime and speech recipes

- [ ] **Voice recipe fixes** (before or with the `@effect-uai/ui` phase 2
      port): `camera-assistant` reuses tag `0x02` (video) that means playback
      position in `realtime-voice-agent`, and its `played` reports are never
      consumed; all three drop `usage` and VAD `speech-stopped`.
- [ ] **`call-supervisor` recipe**. Source: `plans/realtime.md:396`.
- [ ] **`RealtimeSession.resumable` helper** (resumption handles are unused
      by recipes). Source: `plans/realtime.md:398`.
- [ ] **Headless `--input file.wav` for `realtime-voice-agent`**. Source:
      `plans/realtime.md:400`.
- [ ] **Live check: camera assistant (R8)** (needs a browser and a camera).
      Source: `plans/realtime.md` (~575).

## Recipes and docs

- [ ] **`Loop.untilNoToolCalls` as a recipe**. Source: roadmap:47.
- [ ] **`Stream.runFold` `LazyArg` callout** in docs/skill. Source: roadmap:50
      (§ at :1225).
- [ ] **Proposed recipes not yet written** (`plans/recipes.md:36-46`):
      per-request token budget, per-tool timeout, mid-turn user injection,
      validation + retry, replay mode via `MockProvider`, OTel-traced loop, cost
      tracking. Some overlap existing recipes (model-escalation, model-retry,
      basic-metrics, agentic-loop); check before writing.
- [ ] **Provider-author guide for capability markers** (register-the-marker
      contract; markers don't survive JSON). Source:
      `plans/capabilities-plan.md:733-740`.
- [ ] **Skill section on `LanguageModel.use` vs `yield*` and
      `IncompleteTurn`** (mentioned once in `skills/effect-uai/SKILL.md`, no
      dedicated section). Source: roadmap:46.

## Compat

- [ ] **`@effect-uai/ai-sdk`: accept `ToolEvent` (and pass through
      `MetricEvent` mapping) natively**: `examples/ai-sdk-next` hand-writes
      `toEmission` to merge `TurnEvent | ToolEvent | MetricEvent`.

## Done or dropped (do not re-propose)

- `LanguageModel.turn` (`language-model/LanguageModel.ts:76`); `Turn.assistantText` (`domain/Turn.ts:123`); `Tool.fromStandardSchema`; `MockProvider` (`testing/MockProvider.ts`); `Retry.stream` / `Retry.effect` (`retry/Retry.ts:95`); `decodeJsonLinesRecoverable`; OpenAI-compatible provider (`providers/chat-completions`); TTFT/metrics (`recipes/basic-metrics`, `observability/Metrics.ts`); chat → Items adapter (`compat/ai-sdk/src/Messages.ts`).
- Realtime review fixes R1-R7 (R7 tool helper and weather shrink were declined, superseded by the realtime tool helper item above if it is picked up).
- HITL `Resolvers` rename (`tool/Approval.ts`); browser plan items (`providers/browser/src/Connect.ts`); Mistral open questions (package shipped).
- Gemini URL-form image input: intentional `Unsupported` (`google/src/codec.ts:536`), per "SDKs implement generation, not resource management".
- Effect v3 compatibility: out of scope. Managed agents: design note only (`plans/managed-agents.md:3`).
