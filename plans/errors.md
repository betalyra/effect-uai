# Provider Error Taxonomy for `AiError` Tagged Union

> Input doc for the Effect-TS `AiError` redesign called out as the **#1 blocker** in
> [`use-case-new-implementation.md`](./use-case-new-implementation.md) (§3 retry,
> §4 fallback, §11.6 rate limiter, §"Per-error-class retry policies (header-aware)").
>
> Audit complaints this addresses:
>
> - **#3 — Retry on transient model failure.** "`AiError` is currently a single class. We
>   need it to be a tagged union so `Schedule.whileInput` / `Stream.catchTag` can
>   distinguish `RateLimited` / `Unavailable` / `Timeout` / `ContentFiltered` /
>   `InvalidRequest` / `AuthFailed`."
> - **#5 — Per-error-class retry policies (header-aware).** "The provider has to populate
>   `retryAfter` from `retry-after` / `anthropic-ratelimit-tokens-reset` headers — unique
>   whitespace per the research doc."
> - **§11.6 RateLimiter.** "+helper built on top of typed `AiError.RateLimited.retryAfter`."
>
> The whole point: `Stream.catchTags({ RateLimited: …, Unavailable: …, Timeout: … })` only
> works if every provider adapter normalizes its raw error stream into a fixed,
> finite, **provider-agnostic** error vocabulary — and preserves enough raw data
> (`retryAfter`, `requestId`, original payload) for header-aware backoff and
> debugging.

---

## 1. Why typed errors

A single `AiError` class forces every retry/fallback decision to be a string
match against `message` or `cause`. That is exactly the failure mode the audit
calls out as universally weak across LLM SDKs (header-aware retries are the
"whitespace per the research doc").

Three things break under an untyped error channel:

1. **Retry decisions are guesswork.** `Stream.retry(Schedule.whileInput(e =>
e._tag === "RateLimited"))` cannot exist without a `_tag`. Without it, naive
   retry runs against terminal errors (`InvalidRequest`, `AuthFailed`,
   `ContentFiltered`) and burns budget.
2. **Fallback ladders need provenance.** `withFallback({ retryableTags:
["Unavailable", "RateLimited"] })` needs to know "did this provider fail in a
   way another provider could succeed at?" `ContextLengthExceeded` is fixable by
   switching to a larger-context model; `AuthFailed` is not fixable by switching
   providers; `ContentFiltered` is _terminal everywhere_ and must not cascade.
3. **Header-aware backoff requires structured `retryAfter`.** OpenAI's
   `x-ratelimit-reset-tokens: 23h47m36.648s`, Anthropic's
   `anthropic-ratelimit-tokens-reset: 2026-04-27T14:32:11Z`, Groq's
   `retry-after: 12`, and Vertex's empty-headers-with-backoff-required all need
   different parsers. Stream-level `Schedule.exponential` is strictly
   inferior to honoring the header the provider actually returned.

The mid-stream-failure axis adds a fourth: **once SSE has started, the HTTP status
is already 200**. Naive `Stream.retry` will replay the whole turn and emit
duplicate deltas. The audit calls this out as the motivation for
`Stream.retryUntilFirstEmit` (§3 subtlety #2). Typed errors are what makes the
"is this safe to retry?" question answerable.

---

## 2. Proposed normalized error taxonomy

8 tags. Each maps to **all** providers in §3. Rationale is the union of (a)
distinct retry semantics, (b) distinct user-surfacing semantics, (c) what the
audit explicitly enumerates.

| Tag                     | Retryable?        | Header-driven? | What it represents                                                                                                                                        |
| ----------------------- | ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RateLimited`           | yes, with delay   | **yes**        | 429 / RESOURCE_EXHAUSTED / ThrottlingException. Carries `retryAfter: Duration` + which limit (RPM/TPM/RPD).                                               |
| `Unavailable`           | yes, with backoff | sometimes      | 5xx, network reset, model-down, `overloaded_error` (Anthropic 529), Vertex `UNAVAILABLE`, OR-502/503.                                                     |
| `Timeout`               | yes (idempotent)  | no             | 408 / 504 / `timeout_error` / DEADLINE_EXCEEDED / TCP idle close. Distinct from `Unavailable` for backoff math.                                           |
| `ContentFiltered`       | **no — terminal** | no             | OpenAI `content_filter` finish, Gemini `SAFETY` / `RECITATION`, OR-403, Azure `ResponsibleAIPolicyViolation`.                                             |
| `ContextLengthExceeded` | conditional       | no             | `context_length_exceeded`, `request_too_large` (413), oversize-prompt 400s. Retryable only after trimming/compaction or fallback to longer-context model. |
| `InvalidRequest`        | **no — terminal** | no             | 400 / 422 schema errors, unsupported-feature errors, prefill-not-supported. Bug in caller.                                                                |
| `AuthFailed`            | **no — terminal** | no             | 401 / 403 (non-content), `permission_error`, `billing_error` (402), `insufficient_quota`. Fix is out-of-band.                                             |
| `Cancelled`             | **no — terminal** | no             | Caller aborted (Effect interruption, AbortSignal). Distinct from `Timeout` for telemetry.                                                                 |

### Why not collapse some?

- **`Timeout` separate from `Unavailable`.** Anthropic distinguishes
  `timeout_error` (504) from `api_error` (500) and `overloaded_error` (529). The
  retry math differs: timeouts mean "your request took too long, retry sooner";
  529s mean "fleet is hot, back off harder."
- **`ContextLengthExceeded` separate from `InvalidRequest`.** This one is
  _recoverable by changing strategy_ (compact, summarize, switch to a 200k-
  context model). Lumping it into `InvalidRequest` (terminal) loses the
  fallback signal. The audit's #4 ("fallback to bigger model") relies on this.
- **`AuthFailed` separate from `InvalidRequest`.** Different remediation
  (rotate key vs fix code). Different surface (page on-call vs. crash the
  request). Anthropic's `billing_error` (402) is closer to `AuthFailed`
  semantically than `InvalidRequest`.
- **`Cancelled` separate from everything.** This is the user-pressed-stop case;
  it's terminal but not a _failure_ of the system. The audit (§"Cancellation /
  resilience tests") wants this distinguishable for telemetry.

### What each tag carries

```ts
type AiError =
  | {
      _tag: "RateLimited"
      retryAfter?: Duration
      scope?: "rpm" | "tpm" | "rpd" | "tpd"
      provider: string
      raw: unknown
      requestId?: string
    }
  | {
      _tag: "Unavailable"
      retryAfter?: Duration
      status?: number
      provider: string
      raw: unknown
      requestId?: string
    }
  | { _tag: "Timeout"; provider: string; raw: unknown; requestId?: string }
  | { _tag: "ContentFiltered"; reason?: string; provider: string; raw: unknown; requestId?: string }
  | {
      _tag: "ContextLengthExceeded"
      modelLimit?: number
      requested?: number
      provider: string
      raw: unknown
    }
  | { _tag: "InvalidRequest"; param?: string; provider: string; raw: unknown; requestId?: string }
  | {
      _tag: "AuthFailed"
      subtype: "auth" | "permission" | "billing" | "quota"
      provider: string
      raw: unknown
    }
  | { _tag: "Cancelled"; provider: string }
```

`raw` is mandatory and **opaque** — never matched on by retry logic, but
preserved for `console.error`, breadcrumbs, and the inevitable "what
_actually_ came back from the provider?" debug session.

---

## 3. Big table — provider × normalized tag

Provider's **actual** error type/code, status, and headers. Empty cells (`—`)
mean the provider has no native equivalent (and the adapter must synthesize the
tag from a different signal — see §4 per-provider notes).

| Tag                       | OpenAI Chat/Responses                                                      | Anthropic Messages                                                                     | Gemini (`generateContent` / `streamGenerateContent`)                           | OpenRouter (OAI-compat)                                      | AWS Bedrock (Converse / ConverseStream)                             | Azure OpenAI                                                                     | Vertex AI (GCP Gemini)                      | Mistral                                                         | Groq                                                              | DeepSeek                            | xAI (Grok)         | Cohere                            | Together / Fireworks / Cerebras                                           |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------- | ------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| **RateLimited**           | 429 `rate_limit_exceeded` / `tokens_exceeded`; headers `x-ratelimit-*`     | 429 `rate_limit_error`; headers `anthropic-ratelimit-*`; also "acceleration limits"    | 429 `RESOURCE_EXHAUSTED`                                                       | 429 (rate-limited; passthrough)                              | `ThrottlingException` (429-equiv)                                   | 429 `RateLimitReached`; `Retry-After`, `x-ratelimit-remaining-{tokens,requests}` | 429 `RESOURCE_EXHAUSTED` (often headerless) | 429 (standard)                                                  | 429; headers `retry-after`, `x-ratelimit-reset-{requests,tokens}` | 429 rate-limit                      | 429 standard       | 429 (no documented `retry-after`) | 429 — Fireworks serverless = quota; dedicated = capacity (still 429)      |
| **Unavailable**           | 500 `server_error`; 503 `service_unavailable` / "Slow Down"                | 500 `api_error`; **529 `overloaded_error`** (mid-stream possible)                      | 500 `INTERNAL`; 503 `UNAVAILABLE`                                              | 502 (model down / bad upstream); 503 (no provider available) | `InternalServerException`; `ModelStreamErrorException` (mid-stream) | 500 / 503; "Service unavailable"                                                 | 500 `INTERNAL`; 503 `UNAVAILABLE`           | 5xx                                                             | 5xx                                                               | 500, 503                            | 5xx                | 5xx                               | 5xx; Fireworks "server overloaded" sometimes returned as 429-with-message |
| **Timeout**               | 408 (rare)                                                                 | **504 `timeout_error`**                                                                | 504 `DEADLINE_EXCEEDED`                                                        | 408 timeout                                                  | (SDK-side timeout — no AWS-named exception)                         | 408 / SDK timeout                                                                | 504 `DEADLINE_EXCEEDED`                     | timeout via 5xx / SDK                                           | timeout via SDK                                                   | timeout via 5xx                     | timeout via SDK    | timeout via SDK                   | timeout via SDK                                                           |
| **ContentFiltered**       | **`finish_reason: "content_filter"`** (NOT an HTTP error)                  | (rare; usually a stop-reason; `refusal` content block)                                 | **`finishReason: "SAFETY"` / `"RECITATION"`**, or `promptFeedback.blockReason` | 403 (input flagged for moderation-required model)            | Bedrock guardrails: `stopReason: "content_filtered"`                | 400 `content_policy_violation` / `ResponsibleAIPolicyViolation` (inner_error)    | `finishReason: "SAFETY"` (same as Gemini)   | —                                                               | —                                                                 | —                                   | —                  | —                                 | —                                                                         |
| **ContextLengthExceeded** | 400 `context_length_exceeded` (type: `invalid_request_error`)              | 400 `invalid_request_error` (no dedicated code); 413 `request_too_large` for raw bytes | 400 `INVALID_ARGUMENT` w/ "input too long"                                     | passthrough of upstream                                      | `ValidationException` w/ length message                             | 400 `context_length_exceeded`                                                    | 400 `INVALID_ARGUMENT`                      | 400                                                             | 400                                                               | 400                                 | 400                | 400                               | 400                                                                       |
| **InvalidRequest**        | 400 `invalid_request_error` / 422                                          | 400 `invalid_request_error`; 413 `request_too_large`                                   | 400 `INVALID_ARGUMENT`                                                         | 400 (bad params, CORS)                                       | `ValidationException`                                               | 400                                                                              | 400 `INVALID_ARGUMENT`                      | 400 / **422 unprocessable** (very common w/ unsupported params) | 400                                                               | 400 / 422 `Unprocessable Entity`    | 400                | 400                               | 400                                                                       |
| **AuthFailed**            | 401 `invalid_api_key`; 403 country-not-supported; 429 `insufficient_quota` | 401 `authentication_error`; 402 `billing_error`; 403 `permission_error`                | 403 `PERMISSION_DENIED`; 400 `FAILED_PRECONDITION` (free-tier region/billing)  | 401 invalid creds; 402 insufficient credits                  | `AccessDeniedException`                                             | 401; 403                                                                         | 403 `PERMISSION_DENIED`                     | 401 / 403                                                       | 401 / 403                                                         | 401; **402 `Insufficient Balance`** | 401; 403           | 401 / 403                         | 401 / 403                                                                 |
| **Cancelled**             | client AbortSignal                                                         | client AbortSignal                                                                     | client AbortSignal                                                             | client AbortSignal                                           | SDK abort                                                           | client AbortSignal                                                               | client AbortSignal                          | client AbortSignal                                              | client AbortSignal                                                | client AbortSignal                  | client AbortSignal | client AbortSignal                | client AbortSignal                                                        |

**Sources for the table:**

- [Anthropic Errors](https://platform.claude.com/docs/en/api/errors)
- [Anthropic Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic Rate Limits](https://platform.claude.com/docs/en/api/rate-limits)
- [OpenAI Error Codes](https://developers.openai.com/api/docs/guides/error-codes)
- [OpenAI Rate Limits](https://developers.openai.com/api/docs/guides/rate-limits)
- [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [Gemini Troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting)
- [Gemini Safety settings](https://ai.google.dev/gemini-api/docs/safety-settings)
- [OpenRouter Errors & Debugging](https://openrouter.ai/docs/api/reference/errors-and-debugging)
- [OpenRouter Streaming](https://openrouter.ai/docs/api/reference/streaming)
- [AWS Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)
- [AWS Bedrock ConverseStreamOutput (event types)](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStreamOutput.html)
- [Vertex AI 429 handling](https://cloud.google.com/blog/products/ai-machine-learning/learn-how-to-handle-429-resource-exhaustion-errors-in-your-llms)
- [Mistral Error Glossary](https://docs.mistral.ai/resources/error-glossary)
- [Mistral API Error Codes](https://docs.mistral.ai/workflows/managing-workflows-in-production/error_codes)
- [Groq Errors](https://console.groq.com/docs/errors)
- [Groq Rate Limits](https://console.groq.com/docs/rate-limits)
- [DeepSeek Error Codes](https://api-docs.deepseek.com/quick_start/error_codes)
- [xAI Streaming](https://docs.x.ai/docs/guides/streaming-response)
- [xAI Debugging](https://docs.x.ai/docs/key-information/debugging)
- [Cohere Errors](https://docs.cohere.com/reference/errors)
- [Cohere Rate Limits](https://docs.cohere.com/docs/rate-limits)
- [Fireworks Inference Error Codes](https://docs.fireworks.ai/guides/inference-error-codes)

---

## 4. Per-provider notes (quirks worth knowing)

### OpenAI (Chat Completions + Responses API)

- **Error JSON shape** (consistent across both APIs):

  ```json
  {
    "error": {
      "message": "...",
      "type": "invalid_request_error",
      "code": "context_length_exceeded",
      "param": "messages"
    }
  }
  ```

  Both `type` and `code` are populated; `code` is the more granular handle for
  retry decisions. Adapter should match `code` first, fall back to `type`, fall
  back to status.

- **`content_filter` is a `finish_reason`, NOT an HTTP error.** This is the
  single biggest gotcha in the OAI surface. The HTTP response is 200, the
  stream completes normally, the last chunk's `choices[0].finish_reason` is
  `"content_filter"`. The adapter has to lift this into `ContentFiltered`
  _after_ normal stream consumption — not via the error channel. (See
  [openai-node#337](https://github.com/openai/openai-node/issues/337) — even
  the official SDK historically dropped this.)

- **`insufficient_quota` is a 429**, not a 402. This makes header-driven retry
  _wrong_: the SDK gets `Retry-After`, retries, gets the same 429 forever.
  Adapter must inspect `error.code === "insufficient_quota"` and lift to
  `AuthFailed { subtype: "quota" }` rather than `RateLimited`. See
  [community thread](https://community.openai.com/t/i-keep-getting-an-error-you-exceeded-your-current-quota-please-check-your-plan-and-billing-details/537053).

- **Responses API** has a richer mid-stream `event: error` SSE frame:

  ```
  event: error
  data: {"type": "error", "code": "server_error" | "rate_limit_exceeded" | "invalid_prompt", "message": "..."}
  ```

  See [Responses streaming events ref](https://developers.openai.com/api/reference/resources/responses/streaming-events).
  Chat Completions' mid-stream behavior is less standardized — historically
  emits an SSE chunk with an `error` field, but [some compat-servers
  deviate](https://github.com/aaif-goose/goose/issues/8021).

- **Rate-limit headers on every response (success & failure):**
  - `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`
  - `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`
  - Reset values are **duration strings** (`"23h47m36.648s"`), not integers.
    Parser must handle both that and the older `Retry-After: <seconds>` form.

### Anthropic (Messages API)

- **529 `overloaded_error` is its own status.** Not 503, not 429. Audit doc
  cites this specifically. Maps to `Unavailable` with backoff.

- **Mid-stream errors via `event: error` SSE frame.** Documented on the
  [streaming page](https://platform.claude.com/docs/en/build-with-claude/streaming):

  ```
  event: error
  data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
  ```

  Critically, the HTTP status was 200 — so a `Stream.retry` policy keyed on
  HTTP error never fires. Adapter must intercept this SSE frame and lift it
  into the typed error channel. The `error.type` here matches the HTTP-level
  `error.type` taxonomy (`overloaded_error` / `api_error` / `timeout_error`),
  so the same mapping table works.

- **Two different rate-limit dimensions.** `anthropic-ratelimit-tokens-*`
  (combined) **and** `anthropic-ratelimit-input-tokens-*` /
  `anthropic-ratelimit-output-tokens-*` (split). Reset values are **RFC 3339
  timestamps** (e.g. `2026-04-27T14:32:11Z`), not durations. Adapter should
  pick the **most-restrictive** reset across all three dimensions for
  `retryAfter`.

- **`request-id` header on every response.** Surface this in `AiError.requestId`
  unconditionally — Anthropic support requires it.

- **413 is served by Cloudflare**, not Anthropic, so you get a different
  body shape. Treat as `ContextLengthExceeded` (or `InvalidRequest`) but don't
  expect `error.type`.

### Google Gemini (generativelanguage.googleapis.com)

- **Safety blocks are NOT errors.** They come back via:
  - `promptFeedback.blockReason` (when the **prompt** is blocked — no candidates
    returned), values include `SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`.
  - `candidates[i].finishReason` of `SAFETY`, `RECITATION`, `BLOCKLIST`,
    `PROHIBITED_CONTENT`, `SPII`, `MAX_TOKENS`, `OTHER` (for non-success exits).
  - HTTP status is **200**.

  Adapter must walk `promptFeedback` and per-candidate `finishReason` to lift
  into `ContentFiltered`. `MAX_TOKENS` is _not_ an error — it's a normal
  truncation. `RECITATION` _is_ a content filter (copyright). Sources:
  [Safety settings](https://ai.google.dev/gemini-api/docs/safety-settings),
  [coldfusion writeup of `FinishReason: SAFETY`](https://coldfusion-example.blogspot.com/2026/02/how-to-fix-finishreason-safety-and.html).

- **`streamGenerateContent` SSE has no `error` event type.** A first-chunk
  error returns 400 _with an SSE-formatted body_ (yes, really —
  [litellm#18756](https://github.com/BerriAI/litellm/issues/18756)). After the
  first chunk, mid-stream errors appear as `data: {...}` chunks containing
  a top-level `error` field on the JSON, not as a distinct SSE event type.

- **Two URL params change behavior**: `?alt=sse` returns proper SSE; without
  it, `streamGenerateContent` may return a single JSON array
  ([litellm#15293](https://github.com/BerriAI/litellm/issues/15293)).

- **Rate-limit headers are sparsely documented.** The troubleshooting page
  doesn't list them. In practice, `Retry-After` is sometimes set on 429s but
  _not always_. Adapter should default to exponential backoff w/ jitter when
  the header is absent ([Vertex 429 guide](https://cloud.google.com/blog/products/ai-machine-learning/learn-how-to-handle-429-resource-exhaustion-errors-in-your-llms)
  recommends the same).

### OpenRouter (OpenAI-compatible)

- **Passes through upstream errors with metadata.** The unified shape is:

  ```json
  {
    "error": {
      "code": 402,
      "message": "...",
      "metadata": {
        "provider_name": "anthropic",
        "raw": {
          /* original */
        }
      }
    }
  }
  ```

  Adapter should keep `metadata.raw` in `AiError.raw` and surface
  `metadata.provider_name` so downstream telemetry knows _which_ upstream
  failed.

- **Mid-stream error signaling is excellent.** Per
  [OpenRouter errors-and-debugging docs](https://openrouter.ai/docs/api/reference/errors-and-debugging):
  HTTP stays 200; a final SSE `data:` frame includes:

  ```json
  {
    "id": "...",
    "object": "chat.completion.chunk",
    "model": "...",
    "provider": "...",
    "error": { "code": "...", "message": "..." },
    "choices": [
      {
        "index": 0,
        "delta": { "content": "" },
        "finish_reason": "error",
        "native_finish_reason": "..."
      }
    ]
  }
  ```

  The `finish_reason: "error"` is the canonical "this stream failed
  mid-flight" sentinel. **No other provider does this cleanly** — copy the
  pattern when normalizing.

- **402 = insufficient credits, NOT 429.** Maps to `AuthFailed { subtype:
"billing" }`, not `RateLimited`.

- **403 = "your input was flagged for a moderation-required model."** Maps to
  `ContentFiltered`, not `AuthFailed`. Distinct from "no permission to use the
  model" (which OpenRouter doesn't emit; it's a routing-level 503 instead).

- **503 = "no available model provider that meets routing requirements."**
  This is `Unavailable`, but it's _terminal-for-the-current-config_ — retry
  won't help unless caller relaxes routing constraints. Some adapters lift to
  `InvalidRequest`; we keep `Unavailable` and let the caller decide.

### AWS Bedrock (Converse / ConverseStream)

- **All errors are AWS-style typed exceptions**, not OAI-style JSON:
  - `ThrottlingException` → `RateLimited`
  - `InternalServerException` → `Unavailable`
  - `ModelStreamErrorException` → `Unavailable` (mid-stream)
  - `ValidationException` → `InvalidRequest` / `ContextLengthExceeded`
  - `AccessDeniedException` → `AuthFailed`
  - `ServiceUnavailableException` / `ServiceQuotaExceededException` → `Unavailable` / `RateLimited`
  - `ModelNotReadyException` → `Unavailable` (cold-start; specific to provisioned throughput)
  - `ModelTimeoutException` → `Timeout`

- **Mid-stream errors are first-class events in the EventStream protocol.**
  `ConverseStreamOutput` is a tagged union where one variant _is_ the
  `internalServerException` / `modelStreamErrorException` / `throttlingException` /
  `validationException` / `serviceUnavailableException`. The SDK surfaces these
  as exceptions on `for await` of the stream. See
  [ConverseStreamOutput docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStreamOutput.html).

- **Anthropic-via-Bedrock loses anthropic-ratelimit headers.** They're
  Anthropic-API-only. Bedrock reports its own quota via SigV4 / CloudWatch,
  not response headers. `retryAfter` will usually be `undefined`; rely on
  exponential backoff.

### Azure OpenAI

- **Largely OpenAI-compatible** but adds:
  - `400 content_policy_violation` with `inner_error.code:
"ResponsibleAIPolicyViolation"` and `inner_error.content_filter_result`
    (categories: `sexual`, `violence`, `hate`, `self_harm`, `jailbreak`,
    `profanity` with `filtered: bool` and `severity`). This is a 400 error,
    NOT a 200-with-`finish_reason` like raw OpenAI. Map to `ContentFiltered`.
    See [Microsoft Q&A on content_filter_error](https://techcommunity.microsoft.com/discussions/azure/azure-openai-content-filter-result-is-always-content-filter-error/4370163).

- **Rate-limit headers same names as OpenAI** (`x-ratelimit-remaining-tokens`,
  `x-ratelimit-remaining-requests`) plus a `Retry-After` in seconds, but
  Microsoft has acknowledged these are sometimes incorrect on Responses API
  ([MS Q&A](https://learn.microsoft.com/en-us/answers/questions/5625878/azure-openai-responses-api-x-ratelimit-headers-val)).
  Treat with caution; use header value if present, else exponential backoff.

### Vertex AI (Google Gemini via GCP)

- **Same RPC status enum as Gemini direct** but wrapped in google.rpc.Status
  envelope; HTTP body is:
  ```json
  { "error": { "code": 429, "status": "RESOURCE_EXHAUSTED", "message": "...", "details": [...] } }
  ```
- **No reliable rate-limit headers.** Vertex's documented advice on 429s
  ([cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/learn-how-to-handle-429-resource-exhaustion-errors-in-your-llms))
  is "exponential backoff with jitter" — they explicitly do not promise a
  `Retry-After`. Adapter should default to backoff and treat `retryAfter` as
  optional even on 429.
- **Quota dimensions are split** (RPM vs TPM vs concurrent). The error
  `details` array sometimes contains `quotaFailure.violations[]` naming which
  one. Stash in `AiError.raw` for inspection.

### Mistral

- **422 is dominant for parameter errors** rather than 400. Many client libs
  trip on this because `stop`, `user`, `frequency_penalty`,
  `presence_penalty` aren't supported on all models and emit 422
  ([open-webui#10227](https://github.com/open-webui/open-webui/discussions/10227)).
- **Error JSON includes `object: "error"`** (mirrors OpenAI's quirk):
  `{ "object": "error", "message": "...", "type": "...", "param": "...", "code": "..." }`.
- **Streaming terminator is `data: [DONE]`** like OpenAI; mid-stream errors
  not well-documented. Treat `[DONE]` absence + connection close as
  `Unavailable`.

### Groq

- **Best-in-class rate-limit headers.** Mirrors OpenAI naming exactly:
  - `retry-after` (seconds, only on 429)
  - `x-ratelimit-limit-requests` (RPD)
  - `x-ratelimit-remaining-requests` (RPD)
  - `x-ratelimit-reset-requests` (RPD reset)
  - `x-ratelimit-limit-tokens` (TPM)
  - `x-ratelimit-remaining-tokens` (TPM)
  - `x-ratelimit-reset-tokens` (TPM reset)

  Note the **scope mismatch**: requests are per-day, tokens are per-minute.
  Adapter should populate `AiError.RateLimited.scope` accordingly so
  callers know whether to retry in seconds or hours.

### DeepSeek

- **402 `Insufficient Balance`** is its own thing — maps to `AuthFailed {
subtype: "billing" }`. Don't confuse with OpenRouter's 402 (same semantic,
  different docs).
- 422 for invalid params (mirrors Mistral).
- Otherwise standard OAI-compatible.

### xAI (Grok)

- **OpenAI-compatible surface**; error codes follow OpenAI conventions
  (`invalid_request_error`, etc.).
- Streaming via SSE with `stream: true`. Mid-stream error format not
  separately documented — assume OpenAI-shaped.

### Cohere

- Standard 429 for rate limits. Less header structure than OAI/Anthropic.
- Streaming uses Cohere-specific event types (`stream-start`, `text-generation`,
  `stream-end`) rather than OpenAI-shaped chunks. Errors mid-stream surface as
  a `stream-end` with `finish_reason: "ERROR"` and an `error` field.

### Together / Fireworks / Cerebras

- All largely OpenAI-compatible.
- **Fireworks dual-meaning of 429.** On serverless: quota.
  On dedicated: capacity / "server overloaded, please try again later". Same
  HTTP code, different remediation (more replicas vs. wait). Older Fireworks
  responses sometimes returned 429-with-message-only that got mis-mapped to
  `BadRequestError` — explicitly inspect message text. See
  [litellm#9779](https://github.com/BerriAI/litellm/pull/9779) and
  [#11455](https://github.com/BerriAI/litellm/pull/11455). Adapter should map
  the message-text variant to `RateLimited` with `retryAfter` defaulted to a
  conservative value (5–10s).

---

## 5. Streaming-mid-failure (the failure mode that breaks naive retry)

This is the cell of the matrix where `Stream.retry` from Effect quietly does
the wrong thing. **HTTP status is already 200** by the time the error happens,
so retry policies keyed on response status never fire — but the stream still
produces a synthetic error after some deltas have already gone downstream.
Each provider signals this differently.

| Provider                                                   | Mid-stream error mechanism                                                                                                                                         | Looks like                                                                                        | Adapter must lift to                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Anthropic                                                  | **Distinct `event: error` SSE frame.** Documented and reliable.                                                                                                    | `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` | `Unavailable` (529) / mapped via inner `error.type`                       |
| OpenAI Responses                                           | `event: error` SSE frame                                                                                                                                           | `event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"..."}`               | normal mapping by `code`                                                  |
| OpenAI Chat Completions                                    | Inline `error` field on a chunk, no separate event type                                                                                                            | `data: {"id":"...","choices":[],"error":{"message":"...","type":"server_error"}}`                 | Adapter must check every chunk for `error` field                          |
| OpenRouter                                                 | **Final SSE chunk with `finish_reason: "error"`** + top-level `error` object (cleanest design of the bunch)                                                        | `{... "error": {...}, "choices":[{"finish_reason":"error","native_finish_reason":"..."}]}`        | Map by `error.code` / `metadata.raw`                                      |
| Gemini                                                     | **No event-type for errors.** Mid-stream errors land as a regular `data:` chunk with a top-level `error` field. Sometimes the connection just hangs/closes.        | `data: {"error":{"code":500,"status":"INTERNAL","message":"..."}}`                                | Inspect every chunk for `.error`; treat unexpected close as `Unavailable` |
| Vertex AI                                                  | Same as Gemini direct                                                                                                                                              | Same                                                                                              | Same                                                                      |
| AWS Bedrock                                                | **Typed exception event in the EventStream union.** SDKs surface as a thrown exception during async iteration.                                                     | Bedrock SDK throws `ModelStreamErrorException` / `ThrottlingException` mid-iteration              | Map by exception name                                                     |
| Azure OpenAI                                               | Same as OpenAI Chat (inline error field). Content-filter mid-stream often comes as a 200-with-`finish_reason:"content_filter"` and a `content_filter_result` block | Same                                                                                              | `ContentFiltered`                                                         |
| Mistral / DeepSeek / xAI / Together / Fireworks / Cerebras | Implementation-specific (OAI-shaped chunks); **most often the connection closes without `[DONE]`**                                                                 | TCP RST / `[DONE]` absent / inline `error` field                                                  | `Unavailable` if connection close, else map by `error.code`               |
| Cohere                                                     | `stream-end` event with `finish_reason: "ERROR"`                                                                                                                   | Cohere-specific event format                                                                      | Map via Cohere's `finish_reason` enum                                     |
| Groq                                                       | OAI-compatible. Inline `error` field on chunk; otherwise reliable `[DONE]` terminator.                                                                             | OAI-shaped                                                                                        | Map by status / `code`                                                    |

### Why this matters for the loop body

The audit's §3 subtlety #2 (`Stream.retryUntilFirstEmit`) is exactly the
mitigation for this. Once the adapter has emitted _any_ `TextDelta` downstream,
re-running the underlying HTTP call will produce duplicate prefix tokens. The
safe rule:

```
Stream.retryUntilFirstEmit(
  Schedule.exponential("250 millis").pipe(
    Schedule.intersect(Schedule.recurs(3)),
    Schedule.whileInput((e: AiError) =>
      e._tag === "RateLimited" || e._tag === "Unavailable" || e._tag === "Timeout"
    ),
  ),
)
```

→ retries the entire turn while the stream has emitted nothing, becomes a
no-op the moment the first delta passes through. Mid-stream `Unavailable` past
that point is **not retryable** at this layer; it must surface and the loop
body must decide (continue from partial + a continuation prompt à la Claude
4.5 recovery, or fall back, or terminate).

### Provider-specific signal: how to detect "no deltas emitted yet"

Adapter-internal flag, not part of the public error. Anthropic-style
`message_start` does NOT count as an emitted delta — only
`content_block_delta` with non-empty content does. OpenAI's role-only first
chunk (`delta: { role: "assistant" }`) also does NOT count. This matters
because `retryUntilFirstEmit` should let those cosmetic frames pass through
without arming the no-retry-after-this latch.

---

## 6. Header reference (for header-aware retry — §11.6)

The "whitespace per the research doc." The whole reason `RateLimited.retryAfter`
exists. Header names are case-insensitive on the wire but listed canonically.

### Standard cross-provider

| Header                                         | Format                         | Set by                                                  | Adapter behavior                                                     |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `Retry-After`                                  | seconds (int) **or** HTTP date | OpenAI, Azure OpenAI, Groq, OpenRouter, most OAI-compat | Parse as seconds first, fall back to date diff. Set as `retryAfter`. |
| `X-Request-ID` / `request-id` / `x-request-id` | string                         | All major providers (some use one form, some the other) | Always populate `AiError.requestId`.                                 |

### OpenAI / Azure OpenAI / Groq (OAI-style rate-limit headers)

| Header                                 | Meaning                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `x-ratelimit-limit-requests`           | RPM (or RPD on Groq) limit                                |
| `x-ratelimit-remaining-requests`       | RPM/RPD remaining                                         |
| `x-ratelimit-reset-requests`           | duration string (e.g. `"6m0s"`) until RPM/RPD resets      |
| `x-ratelimit-limit-tokens`             | TPM limit                                                 |
| `x-ratelimit-remaining-tokens`         | TPM remaining                                             |
| `x-ratelimit-reset-tokens`             | duration string (e.g. `"23h47m36.648s"`) until TPM resets |
| `x-ratelimit-reset-tokens_usage_based` | (OpenAI only) usage-tier-aware reset                      |

Reset values are **Go-duration-style strings**, not seconds. Parser must
handle `Ns`, `Nm`, `Nh`, and combinations (`1h2m3.4s`).

### Anthropic

| Header                                        | Format                 | Meaning                                           |
| --------------------------------------------- | ---------------------- | ------------------------------------------------- |
| `anthropic-ratelimit-requests-limit`          | int                    | Request limit                                     |
| `anthropic-ratelimit-requests-remaining`      | int                    | Requests remaining                                |
| `anthropic-ratelimit-requests-reset`          | **RFC 3339 timestamp** | When request limit resets                         |
| `anthropic-ratelimit-tokens-limit`            | int                    | Combined token limit                              |
| `anthropic-ratelimit-tokens-remaining`        | int                    | Combined tokens remaining                         |
| `anthropic-ratelimit-tokens-reset`            | RFC 3339 timestamp     | When combined token limit resets                  |
| `anthropic-ratelimit-input-tokens-limit`      | int                    | Input-only token limit                            |
| `anthropic-ratelimit-input-tokens-remaining`  | int                    | Input tokens remaining                            |
| `anthropic-ratelimit-input-tokens-reset`      | RFC 3339 timestamp     | When input-token limit resets                     |
| `anthropic-ratelimit-output-tokens-limit`     | int                    | Output-only token limit                           |
| `anthropic-ratelimit-output-tokens-remaining` | int                    | Output tokens remaining                           |
| `anthropic-ratelimit-output-tokens-reset`     | RFC 3339 timestamp     | When output-token limit resets                    |
| `request-id`                                  | string (`req_…`)       | **Always populate `AiError.requestId`.**          |
| `retry-after`                                 | seconds (int)          | Set on 429s / 529s in addition to ratelimit-reset |

When multiple `*-reset` headers are present, **use the latest timestamp** for
`AiError.RateLimited.retryAfter` — that's the binding constraint.

### Gemini / Vertex AI

- No documented stable rate-limit headers.
- `Retry-After` _sometimes_ on 429s, but [the cloud blog explicitly says
  "use exponential backoff with jitter"](https://cloud.google.com/blog/products/ai-machine-learning/reduce-429-errors-on-vertex-ai)
  rather than relying on it.
- Adapter should set `RateLimited.retryAfter = undefined` when header is
  absent and let the caller's `Schedule.exponential` take over.

### OpenRouter

- Passes through upstream headers when available.
- Sets `Retry-After` on its own 429s.
- No OpenRouter-specific ratelimit headers documented.

### AWS Bedrock

- No HTTP rate-limit headers; SigV4 + AWS quota system.
- Use AWS SDK's built-in retry/backoff (configurable via
  `RetryStrategy` / `HttpRetryOptions`) when available; fall back to
  exponential backoff at our layer.

### Mistral, DeepSeek, xAI, Cohere, Together, Fireworks, Cerebras

- `Retry-After` (seconds) **on 429 only**, when set at all.
- No reliable per-dimension rate-limit headers.
- Adapter behavior: parse `Retry-After` if present, otherwise default to
  exponential backoff.

---

## Implementation checklist (drives the schema work)

1. Define `AiError` as `Schema.TaggedError` union with the 8 tags above.
2. Each tag carries `provider: string` (provider id, for telemetry) and `raw:
unknown` (opaque original).
3. `RateLimited` carries `retryAfter?: Duration` and `scope?: "rpm"|"tpm"|"rpd"|"tpd"`.
4. `Unavailable` carries `retryAfter?: Duration` and `status?: number`.
5. `ContentFiltered` carries `reason?: string` (provider-side label, e.g.
   `"SAFETY"`, `"RECITATION"`, `"hate"`).
6. `ContextLengthExceeded` carries `modelLimit?: number` and `requested?: number`
   when extractable (OpenAI puts these in the message string; Anthropic doesn't).
7. `AuthFailed.subtype: "auth" | "permission" | "billing" | "quota"` so the
   loop body can distinguish "rotate the key" from "top up the wallet."
8. `requestId?: string` populated from `request-id` / `x-request-id` /
   provider-specific headers, on every tag where the provider returned one.

Adapter-side extraction map (build once per provider, not in the loop body):

```
extractAiError(provider, response): AiError
  ↳ status code lookup → tag candidate
  ↳ JSON body `error.type` / `error.code` / RPC status → refine tag
  ↳ headers → populate retryAfter, requestId
  ↳ stash full response (status + headers + body) in `raw`
```

For mid-stream errors, the same `extractAiError` runs against the synthetic
"final-failed-frame" that the SSE parser builds. Adapter normalizes:

- Anthropic `event: error` frame → synthetic `{ status: errorTypeToStatus(error.type), body: data }`
- OpenAI Responses `event: error` frame → same
- OpenRouter `finish_reason: "error"` chunk → same
- Gemini chunk-with-`error`-field → synthetic `{ status: error.code, body: { error } }`
- Bedrock event union variant → directly mapped via exception class name
- "Connection closed without `[DONE]`" → synthetic `Unavailable` with
  `retryAfter: undefined`

This is the layer where `Stream.retryUntilFirstEmit` becomes safe to use.

---

## Open questions / unclear

- **Anthropic `request_too_large` (413)** — served by Cloudflare, response
  body shape not documented. Need to test empirically.
- **Gemini SSE error event format on `streamGenerateContent`** — official
  docs are silent; community reports
  ([litellm#18756](https://github.com/BerriAI/litellm/issues/18756),
  [bifrost#1613](https://github.com/maximhq/bifrost/issues/1613)) suggest
  inconsistent behavior between regional endpoints. Adapter should be
  defensive: scan every chunk for top-level `error` and treat unexpected
  connection close as `Unavailable`.
- **OpenAI Chat Completions mid-stream errors** — the `data: {... "error":
...}` shape is widespread but never canonically documented. Treat as
  observed-de-facto.
- **Cohere mid-stream error format** — `finish_reason: "ERROR"` is referenced
  in some forum posts but not on the [errors page](https://docs.cohere.com/reference/errors).
  Verify against SDK source before relying on it.
- **OpenRouter 503 retryability** — docs say "no available model provider that
  meets your routing requirements." Could be transient (provider just went
  offline) or permanent (routing config is impossible). No way to distinguish
  from response alone. We map to `Unavailable` and let the caller's
  `withFallback` decide.

---

## TL;DR for the schema PR

Implement these 8 tags. Populate `retryAfter` per the §6 header table.
Surface `requestId` always. Lift Anthropic mid-stream `event: error`,
OpenRouter `finish_reason: "error"`, OpenAI Responses `event: error`, and
Gemini chunk-with-`error`-field through the same `extractAiError` path so the
loop body sees one error vocabulary regardless of where in the lifecycle the
provider failed. Combine with `Stream.retryUntilFirstEmit` for safe pre-emit
retries. That unlocks audit complaints #3, #4, #5, and §11.6.
