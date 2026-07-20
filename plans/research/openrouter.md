# Research: OpenRouter API surface

Subagent report, gathered 2026-07-15. Findings marked VERIFIED were confirmed
against vendor docs; others are flagged.

## 1. Chat Completions. VERIFIED

- Endpoint: `POST https://openrouter.ai/api/v1/chat/completions`. Note the
  `/api/v1` prefix, not `/v1`.
- Base URL for OpenAI SDK compat: `https://openrouter.ai/api/v1`
- Auth: `Authorization: Bearer <OPENROUTER_API_KEY>` + `Content-Type: application/json`

Source: https://openrouter.ai/docs/api_reference/overview.md

## 2. Responses API: YES, it exists. Beta. VERIFIED

- Endpoint: `POST https://openrouter.ai/api/v1/responses`
- Status: Beta, explicitly quoted: _"This API is in **beta stage** and may have
  breaking changes."_
- **Critical constraint, STATELESS:** _"Each request is independent and no
  conversation state is persisted between requests."_ Full conversation history
  must be resent every turn. No `previous_response_id` / server-side state, the
  defining feature of OpenAI's Responses API is absent.
- Supported: reasoning with effort levels + encrypted reasoning chains, tool
  calling (incl. parallel), web search with citation annotations, streaming and
  non-streaming.
- Input: `input` accepts a plain string or a structured item array. Assistant
  messages in history require `id` and `status` fields.
- Params verified: `model` (required), `input` (required), `stream`,
  `max_output_tokens`, `temperature`, `top_p`, `tools`, `tool_choice`.
- Response: `id`, `created_at`, `model`, `output[]` (content blocks typed
  `output_text`), `usage`, `status`.
- Streaming events: `response.created`, `response.output_item.added`,
  `response.content_part.added`, `response.content_part.delta`,
  `response.output_item.done`, `response.done`, then `[DONE]`. Described as
  native SSE passthrough matching OpenAI's event format.
- OpenRouter extensions on Responses: `plugins` is confirmed (e.g.
  `"plugins": [{"id": "web", "max_results": 3}]`). **`provider` routing on
  Responses is NOT confirmed**: the Responses docs never mention it. Treat as
  unverified.

Sources: https://openrouter.ai/docs/api_reference/responses/overview.md,
https://openrouter.ai/docs/api_reference/responses/basic-usage.md,
https://openrouter.ai/docs/api_reference/responses/tool-calling.md,
https://openrouter.ai/docs/api_reference/responses/web-search.md

## 3. OpenRouter-specific request fields (chat completions)

- **`models: string[]`**, fallback array. **`route: 'fallback'`**.
- **`provider: {...}`**, verified full schema: `order`, `allow_fallbacks`
  (default true), `require_parameters` (default false), `data_collection`
  ("allow"|"deny"), `only`, `ignore`, `quantizations`, `sort`
  ("price"|"throughput"|"latency", or `{by, partition}`),
  `preferred_min_throughput`, `preferred_max_latency`,
  `max_price: {prompt, completion, request, image}`, `zdr`,
  `enforce_distillable_text`.
- **`plugins: [...]`**: `web`, `context-compression`, `file-parser`, moderation,
  auto-router.
- **`reasoning: {...}`**, see section 8.
- Extra sampling params beyond OpenAI: `top_k`, `repetition_penalty`, `min_p`,
  `top_a`, `verbosity` (low|medium|high|xhigh|max).

Two corrections to prior assumptions:

- **`transforms` / `["middle-out"]` is gone from current docs.** The
  message-transforms page now documents only a `context-compression` plugin
  (`plugins: [{id: "context-compression"}]`), auto-enabled on endpoints ≤8k
  context, opt out via `enabled: false`. No explicit deprecation notice was
  found, so supersession is inferred from absence. The field may still be
  accepted for back-compat, but don't build on it.
- **`usage: {include: true}` is DEPRECATED.** Verbatim: _"The
  `usage: { include: true }` and `stream_options: { include_usage: true }`
  parameters are deprecated and have no effect."_ Usage is now always returned,
  and _"Usage is always included in the final chunk when streaming."_

Sources: https://openrouter.ai/docs/features/provider-routing,
https://openrouter.ai/docs/use-cases/usage-accounting,
https://openrouter.ai/docs/guides/features/message-transforms.md

## 4. Response fields

- `choices[].native_finish_reason`, raw provider finish reason alongside
  normalized `finish_reason`.
- `id`, generation id, format `gen-xxxxxxxxxxxxxx`.
- `usage.cost`, `usage.cost_details.upstream_inference_cost`,
  `usage.prompt_tokens_details.{cached_tokens, cache_write_tokens, audio_tokens}`,
  `usage.completion_tokens_details.reasoning_tokens`, `is_byok`.
- `choices[].message.annotations[]` from the web plugin:
  `{type: "url_citation", url_citation: {url, title, content, start_index, end_index}}`.
- **Top-level `provider` field: NOT verified.** The documented example response
  omits it. It is likely returned in practice, but unconfirmed from docs.
  Verify empirically before decoding it as required.

## 5. Headers

All optional, none required beyond auth:

- `HTTP-Referer`, identifies the app on openrouter.ai leaderboards.
- `X-Title` (aka `X-OpenRouter-Title`), app display name.
- `X-OpenRouter-Categories`, marketplace categorization.

## 6. Streaming. VERIFIED, and documented

Standard SSE, `data: ` prefixed JSON, terminated by `data: [DONE]`. Verbatim from
the docs:

> "OpenRouter occasionally sends comments to prevent connection timeouts. These
> comments look like: `: OPENROUTER PROCESSING`"

> "If you parse the stream by hand, skip lines that start with `:` before calling
> `JSON.parse`. Passing a comment line like `: OPENROUTER PROCESSING` to
> `JSON.parse` throws, and unhandled it will crash your stream loop."

**Mid-stream errors are a second decoder hazard:** they arrive as an SSE event
with a top-level `error` object while **HTTP status stays 200**, accompanied by a
`choices` array with `finish_reason: "error"`. Pre-stream errors return normal
JSON with a real HTTP status code.

This is a known, widely-hit breakage: open issues in docker/docker-agent (#2349)
and symfony/ai (#909) from SSE parsers that don't skip `:` lines.

Source: https://openrouter.ai/docs/api_reference/streaming.md

## 7. Tool calling

Standard OpenAI shape on chat completions (`tools`, `tool_choice`, `tool_calls`,
`parallel_tool_calls` default true). On the Responses API, standard OpenAI items:
`function_call` `{type, id, call_id, name, arguments}` and `function_call_output`
`{call_id, output}`. Tool defs carry `strict: null`.

One deviation worth noting: `function_call_output.output` accepts a **content-part
array (text/images/files), not just a string**, i.e. multimodal tool outputs.
That's a superset of OpenAI's behavior.

## 8. Reasoning

Request `reasoning`: `effort`
("max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none" ≈ 95/95/80/50/20/10/0%
token budget), `max_tokens` (Gemini/Anthropic/Qwen), `exclude` (bool, default
false), `enabled` (bool, maps to medium effort).

Response:

- `choices[].message.reasoning`, plaintext string.
- `choices[].message.reasoning_details[]`, structured array, each
  `{type, id, format, index}` where `type` is one of `"reasoning.summary"` (adds
  `summary`), `"reasoning.encrypted"` (adds `data`), `"reasoning.text"` (adds
  `text`, optional `signature`). `format` example: `"anthropic-claude-v1"`.
- Streaming: `choices[].delta.reasoning_details`, concatenate by order/index.
  Encrypted content may appear redacted mid-stream.

Source: https://openrouter.ai/docs/use-cases/reasoning-tokens

## Key takeaways for decoder and provider design

1. **Must skip `:`-prefixed comment lines** before JSON.parse. Documented, not folklore.
2. **Must handle HTTP-200 mid-stream errors** with top-level `error` +
   `finish_reason: "error"`.
3. **Responses API is beta and stateless**, usable as a wire protocol, but
   `previous_response_id`-style state doesn't exist, so it's effectively "OpenAI
   Responses shape without the stateful part."
4. **Drop `usage: {include: true}` and `transforms`** from any planned request
   builder; both are dead or undocumented now.
5. **Verify the top-level response `provider` field empirically** before marking
   it required in a schema.

Caveat on doc URLs: openrouter.ai has multiple overlapping doc URL trees
(`/docs/api/reference/…`, `/docs/api/api-reference/…`, `/docs/api_reference/…`).
Several 404'd. The `.md` variants listed in https://openrouter.ai/docs/llms.txt
are the canonical, reliable ones.
