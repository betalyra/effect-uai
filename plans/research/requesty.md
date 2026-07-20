# Research: Requesty API surface

Subagent report, gathered 2026-07-15. Findings marked VERIFIED were confirmed
against vendor docs or the OpenAPI spec; inferences are flagged.

**Bottom line: yes to Responses API.** Requesty ships `POST /v1/responses` as a
first-class documented endpoint, present in both the prose docs and the OpenAPI
spec.

## 1. OpenAI-compatible Chat Completions. VERIFIED

- Base URL: `https://router.requesty.ai/v1`. Confirmed in the OpenAPI `servers`
  block as the "Inference router endpoint" (`https://router.requesty.ai`).
- Auth: `Authorization: Bearer $REQUESTY_API_KEY`.
- Endpoint: `POST /v1/chat/completions`. `model` is _optional_, defaults to
  `openai/gpt-4o-mini`; only `messages` is required.
- A second server exists for management: `https://api-v2.requesty.ai` (key/group/
  org CRUD under `/v1/manage/*`).

## 2. Responses API: yes, documented, non-beta

- `POST https://router.requesty.ai/v1/responses`, schema
  `ResponsesRequest`/`ResponsesResponse`.
- Auth accepts **either** `Authorization: Bearer …` **or** Anthropic-style
  `x-api-key: …` (docs: "The Responses endpoint accepts either OpenAI-style
  bearer auth or Anthropic-style `x-api-key` auth").
- **Critical routing nuance**, quoted from
  [responses-create](https://docs.requesty.ai/api-reference/endpoint/responses-create.md):
  "To route OpenAI models through their native Responses API (required for full
  feature parity, including file inputs and the `response.*` event stream), use
  the `openai-responses/` prefix. The standard `openai/` prefix routes through
  Chat Completions under the hood." So `openai-responses/gpt-5` is native
  passthrough; `openai/gpt-5` on `/v1/responses` is a _translation shim_.
- Non-OpenAI models (Anthropic, Gemini, Mistral, Llama) work on `/v1/responses`
  via automatic format conversion.
- Fields: `model`, `input` (string or typed item array), `instructions`,
  `max_output_tokens`, `stream`, `temperature`, `top_p`, `parallel_tool_calls`,
  `tool_choice`, `tools`, `reasoning`, `text`, `include`, `metadata`, `store`,
  `truncation`, `user`.
- **Coverage gaps verified by exhaustive grep of both the full docs corpus and
  the OpenAPI spec:** `previous_response_id` appears **nowhere**, and there is
  **no** `GET /v1/responses/{id}`, despite `store` being documented as "whether
  to store the generated model response for later retrieval via API." So the
  stateful/conversation-chaining half of the Responses protocol appears
  unimplemented or undocumented. Treat `/v1/responses` as stateless-only until
  proven otherwise. **This is an inference from absence, not a documented
  statement.**

## 3. Requesty-specific request fields

All extensions live in a top-level `requesty` object (passed as `extra_body` from
the OpenAI SDK). **None of these are in the OpenAPI spec**, spec-vs-docs drift
worth flagging:

```json
{
  "requesty": {
    "tags": ["workflow-a"],
    "user_id": "user_1234",
    "trace_id": "session_abc123",
    "prompt_id": "localized_product_writer:2",
    "prompt_variables": { "language": "French" },
    "extra": { "country": "canada", "tier": "premium" },
    "auto_cache": true
  }
}
```

- `auto_cache` (bool) works identically on `/v1/chat/completions` and
  `/v1/responses`; inserts provider cache breakpoints (Anthropic/Gemini only,
  ≥1024 tokens).
- `trace_id` doubles as the load-balancing stickiness key.
- **Routing/fallbacks are not request fields.** They're console-defined policies
  referenced via a model prefix: `"model": "policy/sonnet-distribution"`. No
  `models[]` array, no inline fallback config. A real divergence from OpenRouter.
- **Prompt-library gotcha:** "Prompt-level settings override the matching request
  fields, including `temperature`, `max_tokens`, `reasoning_effort`, and
  `response_format`." Console state can silently win over the request body.
- `reasoning_effort` on chat completions; `reasoning: {effort, summary}` on responses.
- **"Smart routing" is not an API surface.** It appears only in blog posts and the
  playground; there's no docs page and no `auto/` model prefix. Don't build
  against it.
- **Guardrails are console-only** (Admin Panel → Guardrails). PII masking/filtering
  applies automatically to all traffic. No per-request fields, and error shapes
  when triggered are undocumented.

## 4. Response fields

Standard OpenAI shapes plus one extension: `usage.cost` (number, USD),
"Requesty's USD cost for this request." Also
`usage.prompt_tokens_details.caching_tokens` (tokens cached _following_ this
prompt), non-standard alongside the usual `cached_tokens`. On `/v1/responses`:
`usage.cost` inside `ResponsesUsage`.

## 5. Headers

- Required: `Authorization: Bearer` (or `x-api-key` on `/v1/responses` and
  `/v1/messages`), `Content-Type: application/json`.
- Optional analytics: `HTTP-Referer`, `X-Title` (OpenRouter-compatible), and
  arbitrary `X-Requesty-<Name>` headers that become analytics dimensions.
  Requesty "extracts the headers and removes them before forwarding to the AI
  provider." Case-insensitive, string values only.

## 6. Streaming

- Chat completions: standard OpenAI SSE, terminated by `data: [DONE]` (verified
  verbatim). Usage is **opt-in**: "By default, streaming responses do not include
  a `usage` object… opt in with `stream_options: {"include_usage": true}`. When
  enabled, an extra chunk is sent right before `data: [DONE]` containing the full
  `usage` object (with an empty `choices` array)."
- Responses: named-event SSE (`response.created`, `response.output_text.delta`,
  `response.completed`). Usage requires **no** opt-in here; `response.completed`
  carries `usage` with `cost`.
- No keepalive/comment-frame behavior is documented anywhere. Unknown, not absent.

## 7. Tool calling

Standard OpenAI. Chat: nested
`{type: "function", function: {name, description, parameters}}` (all three
required per spec). Responses: flat `{type, name, description, parameters,
strict}`. Both add `type: "web_search"`: "Requesty translates the tool to the
provider's native web search format (Anthropic, Vertex/Gemini, OpenAI, xAI,
Perplexity)." Note the chat `Function` schema marks `description` as _required_,
unlike OpenAI where it's optional.

## 8. GDPR / EU: affects the base URL

- EU base URLs: `https://router.eu.requesty.ai/v1` (OpenAI-compatible) and
  `https://router.eu.requesty.ai` (Anthropic-compatible, no `/v1`). Same API key;
  swap the base URL only.
- EU endpoint = Frankfurt, AWS `eu-central-1`; Requesty's own routing/logging/
  caching/analytics stay in EU.
- **The endpoint alone is insufficient:** "To ensure your data never leaves the
  EU, you must also use an EU model." Global models route inference outside the
  EU regardless of endpoint. EU models are identified by region suffixes: Bedrock
  `@eu-central-1`/`@eu-west-1`/`@eu-north-1`, Google `@europe-west1`/
  `@europe-west4`/`@europe-central2`, Azure `@francecentral`/`@swedencentral`;
  Mistral is EU-hosted by default.
- Enforcement is via console Approved Models: restricting to EU-only models
  causes server-side rejection of non-approved models.

## 9. Other API surfaces

From the OpenAPI spec: `/v1/embeddings`, `/v1/images/generations`,
`/v1/images/edits`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/models`
(GET), `/v1/messages` (Anthropic Messages format), `/v1/responses`. Plus an MCP
gateway at `https://router.requesty.ai/v1/mcp` and a management API on
`api-v2.requesty.ai` (`/v1/manage/apikey|group|org`).

## Doc quality assessment

Prose docs are decent and current. The **OpenAPI spec is thin and lags the
prose**: grepping it for `auto_cache`, `"requesty"`, `router.eu`, `policy/`,
`extra_body`, `[DONE]` yields **zero hits for all of them**. Every
Requesty-specific extension is prose-only. Generating a client from `openapi.json`
yields vanilla OpenAI with a `cost` field and nothing else. The spec's
`ChatCompletionRequest` also omits many standard OpenAI fields (`stop`, `n`,
`seed`, `frequency_penalty`, `stream_options`, `reasoning_effort`) that the prose
docs clearly show working, so the spec is under-specified rather than restrictive.

## Sources

[quickstart](https://docs.requesty.ai/quickstart),
[responses-create](https://docs.requesty.ai/api-reference/endpoint/responses-create.md),
[chat-completions-create](https://docs.requesty.ai/api-reference/endpoint/chat-completions-create.md),
[openapi.json](https://docs.requesty.ai/api-reference/openapi.json),
[eu-routing](https://docs.requesty.ai/features/eu-routing.md),
[streaming](https://docs.requesty.ai/features/streaming.md),
[request-metadata](https://docs.requesty.ai/features/request-metadata.md),
[auto-caching](https://docs.requesty.ai/features/auto-caching.md),
[analytics-headers](https://docs.requesty.ai/features/analytics-headers.md),
[fallback-policies](https://docs.requesty.ai/features/fallback-policies.md),
[load-balancing-policies](https://docs.requesty.ai/features/load-balancing-policies.md),
[guardrails](https://docs.requesty.ai/features/guardrails.md),
[llms-full.txt](https://docs.requesty.ai/llms-full.txt).
