# Codebase: native web-search citation handling (as of 2026-07)

> Research note for the deep-research citation-model appendix. Captures how
> provider-native web-search tools and their citations are modeled and
> streamed in the repo today.

## Summary

Citations / web-search results are **NOT streamed incrementally** anywhere in
this repo. The only citation data that survives is OpenAI Responses'
`url_citation` (and file / container citations), and it lands **only on the
final assembled Turn**, attached to `OutputText.annotations`. Anthropic and
Google decode **no** citation / grounding data at all today. Provider-native
web-search calls are modeled as request-side "provider tools" but their
lifecycle emits **no** `TurnEvent` (there is no web-search event variant in
`TurnEvent`).

## 1. OpenAI Responses provider (the only one with citations)

Core annotation types, `packages/core/src/domain/Items.ts:34-78`:

- `UrlCitation` (`Items.ts:34`): `{ type:"url_citation", url, start_index, end_index, title }`
- `FileCitation` (`:43`), `ContainerFileCitation` (`:50`), `FilePath` (`:59`), unioned as `Annotation` (`:66`).
- Attach to `OutputText` (`Items.ts:74-78`): `annotations: Schema.optional(Schema.Array(Annotation))`. Comment at `:30`: shape "mirrors OpenAI Responses API; other providers can omit or map onto these shapes."

Codec decode, `packages/providers/responses/src/codec.ts`:

- `WireUrlCitation` at `codec.ts:10-16`, unioned as `WireAnnotation` (`:38`), carried on `WireOutputTextContent.annotations` (`:48`).
- `web_search_call` item is modeled but hollow: `WireWebSearchCall = Schema.Struct({ type: Literal("web_search_call"), id: optional })` at `codec.ts:89-92`. Comment `:85-88`: hosted-tool calls "are dropped from the turn's items in Phase 1. Surfacing them is a follow-up."
- `wireItemToItem` (`codec.ts:280-282`) maps `web_search_call`, `code_interpreter_call`, `file_search_call` all to `[]` (dropped).
- Annotations pass through only via `wireMessageContentToBlock` (`codec.ts:237-246`): the `output_text` block copies `c.annotations` onto the core `OutputText` block (`:242`), only when present.

Streaming events, `packages/providers/responses/src/streamEvents.ts`:

- The decoded SSE event union `KnownProviderEvent`/`ProviderEvent` (`streamEvents.ts:83-116`) models `output_item.added`, `output_text.delta`, `function_call_arguments.delta`, `reasoning_text.delta`, `reasoning_summary_text.delta`, `refusal.delta/.done`, `completed`, `incomplete`, `failed`, `error`. There is **no** `response.output_text.annotation.added` variant and **no** `web_search_call.*` lifecycle variant.
- `eventToDeltas` (`streamEvents.ts:142-187`) emits **no** `TurnEvent` for web-search lifecycle or annotations. `output_item.added` returns `[]` for non-`function_call` (`:148-152`). Citations only ride in via `response.completed`/`.incomplete` -> `TurnEvent.TurnComplete({ turn: turnFromCompleted(response) })` (`:168-177`).

Conclusion: citations arrive **only on the final assembled `Turn`**, inside `turn.items[].content[].annotations`. No streaming `TurnEvent` carries them; the web-search call itself is dropped from the Turn.

## 2. Anthropic provider (no citation decoding)

- Request side only: `packages/providers/anthropic/src/AnthropicTools.ts` renders a hosted `web_search` tool. `WebSearchConfig` at `:24-31`, constructor `webSearchTool` at `:50-57`, `configToWire` at `:86-98`. Outbound only.
- Decode side: `packages/providers/anthropic/src/codec.ts:34-40` `WireContentBlock` is a union of only `WireTextBlock`, `WireToolUseBlock`, `WireThinkingBlock`, `WireRedactedThinkingBlock`. No `web_search_tool_result` block schema, no `citations` field on `WireTextBlock` (`:11-14` is just `{type, text}`).
- Streaming: `streamEvents.ts` delta kinds `text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta` (`:43-58`). No citation delta.

Conclusion: Anthropic `citations` and `web_search_tool_result` are not modeled or mapped to any core type.

## 3. Google / Gemini provider (no grounding decoding)

- Request side only: `packages/providers/google/src/GeminiTools.ts` renders `googleSearch`, `urlContext`, `codeExecution` (`GeminiToolConfig` `:15-20`, `configToWire` `:62-68`). Native `RequestTool` union `codec.ts:111-121`.
- Decode side: `packages/providers/google/src/codec.ts` wire `Part` union is only `TextPart` and `FunctionCallPart` (`:45`). `Candidate` (`:53-56`) decodes `content` + `finishReason` only. No `groundingMetadata`, `groundingChunks`, `groundingSupports`, or `citationMetadata` schema.

Conclusion: grounding metadata / search results / citations entirely undecoded.

## 4. The "provider tools" abstraction (commit `ba891c3`)

Core type `packages/core/src/tool/Tool.ts`:

- `ProviderTool<Name, Input, Provider, Config>` at `Tool.ts:177-185`: `{ _tag:"ProviderTool", name, description, inputSchema, provider, config, strict? }`. Models server-side / provider-hosted native tools; "executed by the provider ... never by this process. It has no local run" (`:172-176`). One of four tool kinds alongside `LocalTool` (`:150`), `SignalTool` (`:193`), `InteractionTool` (`:206`), unioned as `AnyTool` (`:217-221`).
- Constructor `Tool.provider(...)` at `:286-305`; `Tool.noInput` (`:119`). `isProviderTool` (`:393`), `providerToolsOf` (`:401-404`); `toDescriptors` (`:407-414`) excludes provider tools so each adapter renders them natively.

Per-provider renderers (config -> native wire, all request-side):

- OpenAI: `packages/providers/responses/src/ResponsesTools.ts` `ResponsesToolConfig` (`:45-50`): `web_search`, `code_interpreter`, `file_search`. `renderProviderTools` `:155-158`.
- Anthropic: `AnthropicTools.ts` `AnthropicToolConfig` (`:39`): `web_search`, `code_execution`. `renderProviderTools` `:125-128`.
- Gemini: `GeminiTools.ts` `GeminiToolConfig` (`:15-20`): `google_search`, `url_context`, `code_execution`. `renderProviderTools` `:93-95`.

Key gap: the provider-tools abstraction is **outbound-only**. It renders request `tools[]` entries, but no adapter decodes the corresponding provider-executed results (web-search results, citations, grounding) back into core types or `TurnEvent`s. On OpenAI the `url_citation` annotations survive incidentally on `OutputText.annotations`; on Anthropic and Gemini the results are dropped.
