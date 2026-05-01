# Responses API — gap analysis

What we deliberately punted in the v0 plan
([plans/responses.md](./responses.md): "Out of scope: web_search,
file_search, computer_use, structured output, audio, image, batch APIs,
prompt caching, `previous_response_id`"), what we've shipped since
(`previous_response_id` is in), and what's still missing relative to the
full surface documented at:

- [openresponses.org/specification](https://www.openresponses.org/specification)
- [openresponses.org/reference](https://www.openresponses.org/reference)

Organised by priority so we can pick what to ship next without trying to
swallow the whole API.

## Where we are today

**Request body** (in [packages/providers/responses/src/Responses.ts](../packages/providers/responses/src/Responses.ts)):
`model`, `input`, `stream`, `tools` (function only), `tool_choice`,
`temperature`, `max_output_tokens`, `reasoning.effort`, `store`,
`previous_response_id`. Plus `apiKey` + `baseUrl` on `Config`.

**Items** (in [packages/core/src/domain/Items.ts](../packages/core/src/domain/Items.ts)):
`message` (with `input_text` / `output_text` content blocks),
`function_call`, `function_call_output`, `reasoning`
(`summary` + `signature`/`encrypted_content`).

**SSE events we map** (in
[packages/providers/responses/src/streamEvents.ts](../packages/providers/responses/src/streamEvents.ts)):
`response.output_item.added`, `response.output_text.delta`,
`response.function_call_arguments.delta`,
`response.reasoning_summary_text.delta`, `response.completed`, `error`.
Everything else is silently ignored.

**Stop reasons**: `stop` / `tool_calls` / `max_tokens`.

**Usage**: `input_tokens` / `output_tokens` / `total_tokens`. Token
breakdowns (cached, reasoning) are dropped.

## Tier 1 — should ship next

These are either widely used, cheap to add, or block real production use
cases.

### Top-level request fields

- **`instructions`**. Server-side system prompt. Avoids re-tokenising a
  system message on every turn and keeps it out of the visible `input`.
  Add to `ResponsesRequestOptions` (or as an optional `Config` field
  for "always-on" instructions).
- **`top_p`**. Standard sampling parameter. Pair with `temperature`.
- **`parallel_tool_calls`** (`boolean`). Controls whether the model
  may emit multiple `function_call` items in one turn. We currently
  rely on default behaviour; users sometimes need to force serial
  execution.
- **`metadata`** (`Record<string, string>`). Free-form key-value bag,
  echoed on the response object. Critical for tracing / observability.
- **`user`** + **`safety_identifier`** + **`prompt_cache_key`**. Tracking
  / abuse-routing / explicit cache key. All optional strings.
- **`truncation`** (`"auto" | "disabled"`). Whether the server may drop
  earlier turns when the context grows. Important because the default
  is currently opaque.

### Structured outputs (`text.format`)

The most common request we don't yet model: `text.format =
{ type: "json_schema", name, schema, strict: true }`. Today users have
to put a JSON-shape instruction in the prompt and pray. Concrete shape:

```ts
interface ResponseFormat {
  readonly format:
    | { readonly type: "text" }
    | { readonly type: "json_object" }
    | {
        readonly type: "json_schema"
        readonly name: string
        readonly description?: string
        readonly schema: object  // JSON Schema
        readonly strict?: boolean
      }
  readonly verbosity?: "low" | "medium" | "high"
}
```

We already use `Effect.Schema` everywhere — `Tool.fromEffectSchema` could
have a sibling `ResponseFormat.fromEffectSchema(schema)` that emits the
JSON Schema and the right `text.format` payload.

### Multimodal input

Add to [Items.ts](../packages/core/src/domain/Items.ts) `ContentBlock`:

- **`input_image`** — `{ type, image_url, detail?: "low" | "high" | "auto" }`
- **`input_file`** — `{ type, filename?, file_url?, file_data? }`

Image input alone covers ~90% of the multimodal asks we'll see. The
codec change is purely additive — existing text-only code unaffected.

### Refusal handling

The model can emit refusal text instead of normal output. Currently
this disappears (the SSE events `response.refusal.delta` /
`.refusal.done` aren't mapped, and refusal content blocks on
`output_text` aren't modeled). For safety-sensitive apps this is
silently corrupting.

- Add `Refusal` content block:
  `{ type: "refusal", text: string }`.
- Add `TurnDelta` variant: `{ type: "refusal_delta", text }`.
- New `StopReason`: `"refusal"`.
- Handle `response.refusal.delta` and `.done` events.

### Distinct failure / incomplete events

Today both surface as `AiError.Unavailable`. The spec separates them:

- **`response.failed`** — the model errored out. Maps cleanly to a new
  `AiError.GenerationFailed` or stays under `Unavailable` but with
  `subtype: "generation"`.
- **`response.incomplete`** — content_filter, max_output_tokens,
  max_tool_calls, etc. Should produce a `turn_complete` with
  `stop_reason` reflecting the reason — currently we only catch
  `max_tokens` via the response payload's `incomplete_details`, never
  via the streaming event.

### Annotations on output text

`output_text` content blocks can carry `annotations[]`:

- `url_citation`: `{ type, url, start_index, end_index, title }`
- `file_citation`: `{ type, file_id, index }`
- `container_file_citation`: web/file-search outputs
- `file_path`: code-interpreter output references

We currently drop them. They're how grounded answers report sources.
Add `annotations?: ReadonlyArray<Annotation>` to `OutputText`. A
discriminated union of the four kinds is straightforward.

### Usage details

The wire payload nests `input_tokens_details.cached_tokens` and
`output_tokens_details.reasoning_tokens`. Without them we can't tell:

- Whether `prompt_cache_key` is doing anything.
- How much we're paying for thinking vs output.

Extend [Items.ts](../packages/core/src/domain/Items.ts) `Usage`:

```ts
interface Usage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly total_tokens?: number
  readonly input_tokens_details?: {
    readonly cached_tokens?: number
  }
  readonly output_tokens_details?: {
    readonly reasoning_tokens?: number
  }
}
```

## Tier 2 — provider-hosted tools

These are the meaty additions: server-side tools the user opts into via
the `tools[]` array. Each has its own `*_call` output item type and a
matching set of streaming events. None of them are blocking for current
recipes, but together they're the biggest argument for using Responses
over chat completions.

| Tool             | `tools[]` entry                  | Output item type        | SSE events                               |
| ---------------- | -------------------------------- | ----------------------- | ---------------------------------------- |
| File search      | `{ type: "file_search", ... }`   | `file_search_call`      | `.in_progress` / `.searching` / `.completed` |
| Web search       | `{ type: "web_search" }`         | `web_search_call`       | `.in_progress` / `.searching` / `.completed` |
| Code interpreter | `{ type: "code_interpreter" }`   | `code_interpreter_call` | `.in_progress` / `.executing` / `.completed` |
| Image generation | `{ type: "image_generation" }`   | `image_generation_call` | (not enumerated in spec excerpt)         |
| MCP              | `{ type: "mcp", server_url, ... }` | `mcp_call` (+ `mcp_list_tools`, `mcp_approval_request`) | `.in_progress` / `.completed` |
| Computer use     | `{ type: "computer_use_preview", ... }` | `computer_call` / `computer_call_output` | not enumerated |
| Custom           | `{ type: "<slug>:<name>", ... }` | `custom_tool_call`      | `custom_tool_call_input.delta` / `.done` |

Implementation strategy: each becomes its own discriminator on `Item`
(extending the union beyond `message`/`function_call`/`function_call_output`/`reasoning`)
and its own pre-pipe in the codec. The wire passthrough we already have
(`Item.providerData`) means partial coverage is safe — items we don't
model fully still round-trip via `providerData`. Until we ship the
typed shape, users at least get the raw payload.

### `include[]` parameter

Some computed fields aren't returned by default and require opt-in:

- `"reasoning.encrypted_content"` — for stateless rehydration
- `"message.output_text.logprobs"` — top-token probabilities
- `"file_search_call.results"` — the actual matches, not just the call
- `"code_interpreter_call.outputs"` — execution outputs
- `"computer_call_output.output.image_url"` — screenshots

Add `include?: ReadonlyArray<IncludeKey>` to `ResponsesRequestOptions`
once we've shipped the matching item types.

## Tier 3 — niche

Low traffic but each is a small change.

- **`background: true`** + `GET /v1/responses/:id` + `POST /v1/responses/:id/cancel`
  — async/long-running responses. Unlocks "submit and poll" workflows.
- **`conversation`** parameter — explicit conversation context object.
  Overlaps with `previous_response_id`; would need clarity on which we
  prefer.
- **`prompt`** parameter — server-stored prompt templates with
  variables. Reasonable for teams that manage prompts outside code, but
  cuts against our "prompt is code" stance.
- **`attachments`** — files attached at request level. Different from
  `input_file` content blocks; spec is light on details.
- **Sampling extras** — `seed`, `top_logprobs`, `logit_bias`, `stop`.
  Cheap to add as optional fields.
- **`service_tier`** — `"standard" | "priority" | "batch"`. Pricing
  / latency hint.
- **`max_tool_calls`** — safety cap. We arguably want this on by default
  to prevent runaway loops, but our `loop` primitive already gives the
  user control over iteration count.
- **Audio / video input** — `input_audio`, `input_video` content blocks.
  Wait for a real ask.
- **GET `/v1/responses/:id/input_items`** — inspect a stored response's
  inputs after the fact. Useful for debugging stored conversations.

## Won't do (for now)

- **`n` > 1**. Multiple completions per request don't fit a streaming
  agent loop — we'd have to multiplex `n` sub-streams. If needed,
  emulate via `n` parallel `streamTurn` calls.
- **Per-event streaming dispatch as a public API.** We already collapse
  all SSE events to a small `TurnDelta` shape. Exposing the raw event
  taxonomy upward would re-introduce provider coupling we worked to
  avoid. If a recipe needs raw events, it can pre-pipe before
  `streamUntilComplete`.

## Recommended ship order

1. **Cheap wins, no schema changes**: `top_p`, `parallel_tool_calls`,
   `metadata`, `user`, `safety_identifier`, `prompt_cache_key`,
   `truncation`, `instructions`. One PR, additive on
   `ResponsesRequestOptions`. Send them in the request body, no codec
   work needed.
2. **Usage details**: extend `Usage` with `input_tokens_details` and
   `output_tokens_details`. Surface cached + reasoning tokens.
3. **Refusal + `response.failed` + `response.incomplete`**: the
   safety-blind spot. New content block, new stop reason, new SSE
   events. Single PR.
4. **Annotations** on `output_text`: small schema change, big UX
   improvement for grounded answers.
5. **Multimodal input**: `input_image` first, `input_file` second.
   Codec changes touch both `itemToInput` and the wire schemas.
6. **Structured outputs** (`text.format`): pair with a
   `ResponseFormat.fromEffectSchema` helper so the user-facing shape is
   "a `Schema`, not a `JSONSchema`".
7. **First provider-hosted tool**: pick one based on user demand —
   `web_search` is the most universally useful starting point. Adds
   `WebSearchCall` to `Item`, the matching SSE events, and the
   `web_search` tool type.
8. **`include[]`** alongside the first tool that needs it.
9. **Remaining provider-hosted tools** in priority order:
   `file_search`, `code_interpreter`, `image_generation`, `mcp`,
   `computer_use_preview`, `custom`.
10. **Background mode + retrieve/cancel endpoints**.

Each step is independently shippable and doesn't break callers — the
core `Item` union and `TurnDelta` shape only grow.

## Things to settle while planning

- **Where does `instructions` live?** Per-call option, session-level
  default, or `Config`-level? My lean: per-call, with a session-level
  default once we ship sessions
  ([plans/websocket.md](./websocket.md)).
- **How do `previous_response_id` and `conversation` interact?** Spec
  is unclear. Until we know, we keep `previous_response_id` as the
  canonical continuation hook.
- **Provider-hosted tool result rehydration**. For
  `previous_response_id`-style continuation, the server holds tool
  results. For stateless continuation (which we currently support), the
  user has to round-trip them — but their shapes are richer than
  `function_call_output`. We need to decide whether
  `*_call_output` items get first-class types or stay
  `function_call_output`-shaped with structured `output` strings.
- **Annotation propagation**. When the consumer round-trips an
  assistant message back as history, do we keep annotations? OpenAI
  doesn't seem to expect them on input — so probably strip on
  `itemToInput`.
