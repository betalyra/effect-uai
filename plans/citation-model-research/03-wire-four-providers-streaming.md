# Wire: citation + web-search streaming shapes, 4 core providers (2026)

> Research note for the deep-research citation-model appendix. Docs show 2026
> model names (o3-deep-research, Claude Opus 4.8, web_search tool version
> web_search_20260318). Wire shapes below are stable; preview/converging parts
> flagged.

## 1. OpenAI Responses API: web_search + deep research

Docs: developers.openai.com/api/docs/guides/tools-web-search ; /guides/deep-research ; /api/reference/resources/responses/streaming-events

- (a) Streaming events (SSE, one lifecycle per search call):
  - `response.web_search_call.in_progress` / `.searching` / `.completed` (each carries `item_id`, `output_index`, `sequence_number`).
  - `response.output_text.annotation.added`: fires each time a citation attaches to output text; payload carries `item_id`, `output_index`, `content_index`, `annotation_index`, and the `annotation` object.
  - Text streams via `response.output_text.delta` / `.done`.
  - The `web_search_call` item carries `action`: `search`, `open_page`, or `find_in_page` (the latter two are what deep research emits reading pages).
- (b) Citation schema: `url_citation` `{ type:"url_citation", url, title, start_index, end_index }`.
- (c) Incremental? YES when streaming: each citation arrives as its own `response.output_text.annotation.added`. Non-streaming: bundled in `message.content[0].annotations`.
- (d) Span linking: start/end **character indices** into output text.
- Deep research: `o3-deep-research`, `o4-mini-deep-research`; require at least one data source (`web_search_preview`, remote MCP, or `file_search`); emit reasoning-summary items interleaved with `web_search_call` items.

## 2. Anthropic Messages API: web_search tool

Docs: platform.claude.com/docs/en/docs/build-with-claude/tool-use/web-search-tool ; /citations

- (a) Streaming events / blocks:
  - `server_tool_use` block (`name:"web_search"`, `input.query`); query streams via `content_block_delta` with `input_json_delta`.
  - `web_search_tool_result` block: arrives as a single `content_block_start` carrying the full `content` array (after a pause while search runs); not streamed token-by-token.
  - Answer text emitted as multiple `text` blocks; citations attach via `citations_delta` (`content_block_delta` with `delta.type:"citations_delta"` and `delta.citation:{...}`).
- (b) Citation schema: `web_search_result_location` `{ type, url, title, encrypted_index, cited_text }` (`cited_text` <=150 chars; result blocks carry `url`, `title`, `page_age`, `encrypted_content`). Document (non-web) citations use `char_location` `{start_char_index,end_char_index}`, `page_location`, `content_block_location`.
- (c) Incremental? Search-result blocks bundled whole; citations YES, streamed incrementally via `citations_delta`.
- (d) Span linking: **inline block segmentation, not indices.** Answer split into many `text` blocks; each cited claim is its own `text` block with a `citations` array. `cited_text` is a quote from the source, not an answer offset. (Web-search citations expose no char index into the response, unlike document citations.)
- Long searches can return `stop_reason:"pause_turn"`.

## 3. Google Gemini grounding: two distinct surfaces

3a. Classic `generateContent` grounding (docs: cloud.google.com Vertex GroundingMetadata):
- (a) No search-progress events. Grounding data in `candidate.groundingMetadata`.
- (b) `groundingMetadata`: `webSearchQueries` (string[]); `searchEntryPoint` `{renderedContent, sdkBlob}`; `groundingChunks[]` `{web:{uri,title}, retrievedContext}`; `groundingSupports[]` `{segment:{partIndex,startIndex,endIndex,text}, groundingChunkIndices:int[], confidenceScores:number[]}`.
- (c) Incremental? NO: grounding metadata only in the final response (streaming: last chunk).
- (d) Span linking: `segment.startIndex`/`endIndex` are **byte offsets** into Part text (inclusive start, exclusive end); `groundingChunkIndices` maps a segment to entries in `groundingChunks`. Spans link via indices plus a chunk-index join.

3b. Newer Gemini Interactions API (`google-search` tool, docs: ai.google.dev/gemini-api/docs/google-search):
- Converged on an OpenAI-Responses-style shape: step items `google_search_call` `{queries}` and `google_search_result` `{search_suggestions, call_id}`, text `annotations` with `url_citation` `{url,title,start_index,end_index}` (character indices).
- FLAG: recent/changing. Field vocabulary is entirely different from 3a; decide which surface you target.

## 4. Perplexity sonar / sonar-deep-research

Docs: docs.perplexity.ai/api-reference/chat-completions-post ; /guides/streaming

- (a) No dedicated search-progress SSE events. `stream_mode:"full"|"concise"` controls whether reasoning is emitted separately; deep-research multi-step search is server-side with no per-search events.
- (b) Two arrays at top of completion: `citations` string[] (URLs, legacy, superseded); `search_results[]` `{title(req), url(req), date(opt), last_updated(opt), snippet(default ""), source:"web"|"attachment"}`.
- (c) Incremental? NO: `citations` and `search_results` appear only in the final chunk/snapshot.
- (d) Span linking: neither char indices nor a structured marker object. Model emits bracketed `[1]`, `[2]` references whose numbers correspond to the order of `citations` / `search_results`. Purely positional/textual.
- FLAG: `sonar-deep-research` and the `citations -> search_results` migration are actively changing; treat as preview.

## Comparison table

| Provider | Search-progress events? | Citations streamed incrementally? | Citation object | Span linking |
|---|---|---|---|---|
| OpenAI Responses (web_search, o3-deep-research) | YES (`web_search_call.in_progress/searching/completed`, `action`) | YES (`output_text.annotation.added`) | `url_citation {url,title,start_index,end_index}` | char start/end index into answer |
| Anthropic Messages (web_search) | Partial (`server_tool_use` + `web_search_tool_result` bundled whole) | YES (`citations_delta`) | `web_search_result_location {url,title,encrypted_index,cited_text}` | inline block segmentation; no answer offset |
| Gemini classic (groundingMetadata) | NO | NO (final chunk only) | `groundingChunks[].web{uri,title}` + `groundingSupports[]{segment, groundingChunkIndices, confidenceScores}` | `segment.startIndex/endIndex` byte offsets + chunk-index join |
| Gemini Interactions (google_search), new | Responses-style items | Responses-style annotations | `url_citation {url,title,start_index,end_index}` | char start/end index |
| Perplexity (sonar, sonar-deep-research), preview | NO | NO (final snapshot) | `search_results[]{title,url,date,last_updated,snippet,source}` (+ legacy `citations[]`) | positional `[n]` markers |

## Design implications

- Three span-linking paradigms to abstract over: (1) char/byte offset ranges into the answer (OpenAI, Gemini-classic byte, Gemini-Interactions char); (2) segmentation where the cited claim is its own block (Anthropic); (3) positional bracket markers (Perplexity). A unified span carries `{start,end,unit:"char"|"byte"} | {blockId} | {markerIndex}`.
- Only OpenAI and Anthropic emit citations incrementally; Gemini and Perplexity deliver them bundled at the end. A unified streaming model needs a "citations may arrive only at finalize" mode.
- Only OpenAI (and Gemini Interactions) emit explicit search-progress lifecycle events; Anthropic surfaces search as content blocks; Gemini-classic and Perplexity surface none.
- Watch Gemini's dual surface (byte-indexed groundingMetadata vs char-indexed url_citation); treat Perplexity sonar-deep-research + the citations->search_results migration as still moving.
