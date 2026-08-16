# Research: Jina DeepSearch + Mistral chat APIs

Subagent report, gathered 2026-07-15. Findings marked VERIFIED were confirmed
against vendor docs or multiple independent reports; others are flagged.

## Part A: Jina AI DeepSearch

**1. LLM/chat API exists. VERIFIED.** Jina ships DeepSearch, a reasoning+search
grounding LLM, distinct from the embeddings/reranker/reader surfaces we already
wrap.

**2. OpenAI Chat Completions compatible. VERIFIED.**

- Base URL: `https://deepsearch.jina.ai/v1/chat/completions`. Note: separate host
  from `api.jina.ai`, so it will not share the existing Jina base-URL config.
- Auth: `Authorization: Bearer <JINA_API_KEY>`, same key as the rest of the platform.
- Model id: **`jina-deepsearch-v1`** only. **`jina-deepsearch-v2` does not exist**:
  zero references in Jina's docs, site, or the open-source repo. Don't add it
  speculatively.
- Docs state the schema is fully OpenAI-Chat-compatible ("swap `api.openai.com`
  with `deepsearch.jina.ai`").
- `messages` accepts text plus images (webp/png/jpeg) and files (txt/pdf) up to
  10MB as data URIs.

**3. Jina-specific request fields. ALL VERIFIED** (from jina.ai/deepsearch):

| Field                   | Type                          | Notes                                                                               |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `reasoning_effort`      | `"low" \| "medium" \| "high"` | Tuned preset over `budget_tokens` + `max_attempts`. Only these three.               |
| `budget_tokens`         | integer                       | Token ceiling for the whole search/read/reflect/summarize process                   |
| `max_attempts`          | integer                       | Retries on failed internal quality checks                                           |
| `team_size`             | integer                       | Parallel agents; `>1` enables map-reduce. Shared budget, independent `max_attempts` |
| `no_direct_answer`      | boolean                       | Forces search even for trivial queries                                              |
| `boost_hostnames`       | string[]                      | Prioritized domains                                                                 |
| `bad_hostnames`         | string[]                      | Excluded domains                                                                    |
| `only_hostnames`        | string[]                      | Exclusive whitelist                                                                 |
| `search_provider`       | string                        | e.g. `"arxiv"` for academic-only                                                    |
| `search_language_code`  | string                        | e.g. `"en"`                                                                         |
| `answer_think_language` | string                        | Language of the final answer                                                        |
| `max_returned_urls`     | integer                       | Cap on URLs in the answer                                                           |
| `structured_output`     | boolean                       | JSON-schema matching                                                                |

**4. Citations. VERIFIED.** `annotations` live inside `choices[].delta`
(streaming) / `message` (non-streaming), typed `url_citation`:

```json
"annotations": [{
  "type": "url_citation",
  "url_citation": { "title": "…", "exactQuote": "…", "url": "…", "dateTime": "…" }
}]
```

Important for annotation mapping: the inner object is **camelCase**
(`exactQuote`, `dateTime`), a Jina deviation from OpenAI's `url_citation`, which
uses `start_index`/`end_index`/`title`/`url`. Jina has no index fields; it has
quote + timestamp instead. `visitedURLs`, `readURLs`, `numURLs` are VERIFIED
present, but only on the final chunk, at the top level of the chunk (not inside
`choices`), so a streaming consumer must retain the last chunk to get them. The
open-source repo also emits GitHub-flavored markdown footnotes (`[^1]`) inline in
`content` alongside the structured annotations.

**5. Streaming. VERIFIED.** SSE, `object: "chat.completion.chunk"`, terminated by
`data: [DONE]`. Reasoning is **not** a separate `reasoning_content` field: think
content is inlined into `delta.content` wrapped in `<think>…</think>` XML tags,
and there's a `delta.type: "text"` discriminator. Docs strongly recommend always
streaming: requests average ~57s and can run 40+ steps. Rate limits: 50 RPM
free/paid, 500 RPM premium.

**6. Responses API. NOT SUPPORTED.** No `/v1/responses` on any Jina host. Chat
Completions only.

**7. Tool calling. NOT SUPPORTED.** No `tools` / `tool_calls` / `tool_choice`
anywhere in the docs or the reference implementation. DeepSearch's tool use is
_internal_ (search/visit/reflect/answer/coding actions chosen via an internal Zod
schema); none of it is exposed as OpenAI function calling. Treat this model as
text-in/text-out with citations, no tool loop.

## Part B: Mistral

**1. OpenAI compat: real but with hard deviations.** Same request shape and same
`/v1/chat/completions` path at `https://api.mistral.ai/v1`, but it is a
strict-validation API (rejects unknown fields with 422 rather than ignoring them,
unlike OpenAI). Verified deviations:

- **`max_completion_tokens` is rejected with 422.** Mistral only accepts
  `max_tokens`. This breaks naive OpenAI adapters and is the single
  most-reported incompatibility.
- **`random_seed`, not `seed`**, verified from the official API reference field list.
- **Extra fields on message objects (e.g. `id`) produce 422 "Extra inputs are not
  permitted."** No silent tolerance.
- `tool_choice` accepts **`"auto" | "none" | "any" | "required"`** plus a
  named-tool object. **`"any"` is Mistral-specific** and has no OpenAI
  equivalent; `"required"` is the OpenAI-compatible alias.

**2. Mistral-specific request fields. VERIFIED** from the official reference
(docs.mistral.ai/api):

- `safe_prompt` (boolean, default false), injects a safety system prompt
- `random_seed` (integer|null)
- `prediction` (Prediction|null), predicted outputs / speculative decoding
- `parallel_tool_calls` (boolean, **default true**)
- `prompt_mode`, only documented value is `"reasoning"`
- `reasoning_effort`: `"none" | "minimal" | "low" | "medium" | "high" | "xhigh"`.
  Wider than OpenAI's set; `"none"` and `"xhigh"` are Mistral-only.
- `prompt_cache_key` (string|null), caching at 10% token cost
- `guardrails` (GuardrailConfig[]|null)
- `metadata` (map|null)
- Standard-but-present: `n`, `stop`, `presence_penalty`, `frequency_penalty`,
  `response_format` (`text` | `json_object` | `json_schema`)

`document_image_limit` / `document_page_limit`: **PARTIALLY VERIFIED, treat with
caution.** Not in the official chat-completions reference field list. Only found
in a Microsoft Semantic Kernel PR passing `document_image_limit: 8` /
`document_page_limit: 64` alongside a `document_url` content part. Real enough
that a third-party SDK sends them, but undocumented by Mistral. If modeled, mark
experimental.

**3. Content parts / tool ids / tool_choice:**

- Content is array-of-parts or plain string; part types include `text`,
  `image_url`, and a Mistral-specific **`document_url`** (no OpenAI equivalent).
- **Tool call id constraint. VERIFIED.** Mistral requires `^[a-zA-Z0-9]{9}$`:
  exactly 9 chars, alphanumeric only, no underscores/hyphens/prefixes. Error
  text: `must be a-z, A-Z, 0-9, with a length of 9`. Confirmed across many
  independent bug reports (vercel/ai #11802, opencode #1680, zed #53034, vllm
  #9019, multiple openclaw issues). **This bites hard on fallback/multi-provider
  paths**: OpenAI (`call_…`) and Anthropic (`toolu_…`) ids are rejected outright,
  so every serious integration ships an id-normalization function. Given our
  multi-model-fallback recipe, this must be handled at the provider boundary,
  both when reading ids back and when replaying foreign history into Mistral.
  Applies to both `assistant.tool_calls[].id` and `ToolMessage.tool_call_id`.

**4. Responses API. VERIFIED NOT SUPPORTED.** No `/v1/responses` in the endpoint
list. Full list: Chat, Fim, Embeddings, Classifiers, Files, Models, Batch, Ocr,
Audio Transcriptions/Speech/Voices, Events, Workflows; Public Preview: Beta
Agents, Beta Conversations, Beta Libraries, Beta Connectors, Beta Admin, Beta
Observability, Beta Prompts, Beta Skills, Beta Rag. Mistral's server-side-state
answer is the **Agents/Conversations API** (its own protocol, not OpenAI-shaped);
don't conflate it with Responses.

**5. Streaming SSE: no verified deviation.** Data-only SSE terminated by
`data: [DONE]`, same as OpenAI. No reports of frame-format differences.

**6. Things Mistral has that OpenAI Chat lacks (keep provider-specific):**

- `safe_prompt`, `prompt_mode: "reasoning"`, `guardrails`, `prediction`,
  `prompt_cache_key`
- `reasoning_effort` values `"none"` / `"xhigh"`
- `tool_choice: "any"`
- `document_url` content part (+ the undocumented document limits)
- **Server-side tools in the `tools` array**: `WebSearchTool`,
  `WebSearchPremiumTool`, `CodeInterpreterTool`, `ImageGenerationTool`,
  `DocumentLibraryTool`, `CustomConnector`. These sit in the same `tools` array
  as user function tools but are provider-hosted, structurally like
  Gemini/OpenAI hosted tools. Per `dont_unify_non_uniform`, these stay
  Mistral-typed rather than being promoted into the common request.
- `n` (OpenAI Chat has it, Responses doesn't; relevant if our core request is
  Responses-shaped)

## Confidence caveats

The Jina field table comes from a single marketing/docs page (jina.ai/deepsearch)
rather than a formal OpenAPI spec. Jina publishes no machine-readable schema for
DeepSearch, so exact types/defaults/nullability for the Jina-specific fields are
as-documented, not as-specified. Worth one live probe before finalizing decoders.
Similarly, the `visitedURLs`/`readURLs`/`numURLs` placement on the final chunk is
documented but unconfirmed for non-streaming responses.

## Sources

- [Jina DeepSearch](https://jina.ai/deepsearch/), primary API reference
- [jina-ai/node-DeepResearch](https://github.com/jina-ai/node-DeepResearch),
  reference implementation, `<think>` tags, footnote citations
- [Mistral API reference](https://docs.mistral.ai/api), endpoint list, request schema
- [Mistral migration guides](https://docs.mistral.ai/resources/migration-guides)
- [vercel/ai #11802](https://github.com/vercel/ai/issues/11802),
  [opencode #1680](https://github.com/anomalyco/opencode/issues/1680),
  [zed #53034](https://github.com/zed-industries/zed/issues/53034), tool call id constraint
- [openclaw #47079](https://github.com/openclaw/openclaw/issues/47079), `max_completion_tokens` 422
