# Plan — Responses Tier 1 & 2

Closes the outstanding items in [responses-gaps.md](responses-gaps.md). This
doc only covers what's *still missing* — Tier-1 cheap wins (top-level
request fields, annotations, usage details, refusal streaming) already
shipped and aren't repeated here.

Scope is **Responses-specific**. Anthropic and Gemini are mentioned only
where a change to `Items.ts` (e.g. multimodal `ContentBlock`) affects all
providers' encoders.

## Outstanding Tier 1

### 1. Multimodal input (`input_image`, `input_file`)

[responses-gaps.md §Multimodal input](responses-gaps.md). 90% of multimodal
asks are image-only; image first, file second.

**`Items.ContentBlock`** gains two variants:

```ts
export const InputImage = Schema.Struct({
  type: Schema.Literal("input_image"),
  image_url: Schema.String,
  detail: Schema.optional(Schema.Literals(["low", "high", "auto"])),
})

export const InputFile = Schema.Struct({
  type: Schema.Literal("input_file"),
  filename: Schema.optional(Schema.String),
  file_url: Schema.optional(Schema.String),
  file_data: Schema.optional(Schema.String), // base64
})
```

Add `isInputImage` / `isInputFile` type guards.

**Per-provider encoders** (`itemsToInput` / equivalent):
- **Responses** — pass through almost verbatim (matches the wire).
- **Anthropic** — encode as `{ type: "image", source: { type: "url" | "base64", ... } }` content blocks. `input_file` doesn't have a clean Anthropic equivalent — skip for v1, document.
- **Gemini** — encode as `inlineData: { mimeType, data: base64 }` parts. URL form requires fetching first; document as a follow-up.

**Helper constructors** (in `Items.ts`):

```ts
export const userImage = (url: string, opts?: { detail?: ... }): Message
```

**Out of scope here**: `input_audio`, `input_video`. Wait for a real ask
(responses-gaps Tier-3).

### 2. Refusal completeness

Step 4 of the LLM redesign added `refusal_delta` on `TurnEvent` and
`response.refusal.delta` on the wire. The remaining work:

- **Wire**: model `response.refusal.done` event. Currently flows as `_unknown`.
  Likely emits no canonical event (the deltas already fully covered the
  refusal text) — add an explicit `matchType("response.refusal.done", () => [])`
  branch.
- **`Items.ContentBlock`**: add `Refusal { type: "refusal"; text: string }`
  for assembled-message refusals (so a `Turn`'s assistant message can carry
  refusal content alongside or instead of `output_text`).
- **`StopReason`**: add `"refusal"` to the literal union. Codec maps it from
  the wire's `incomplete_details.reason` or refusal-specific completion
  signal.
- **Decode path**: when `turnFromCompleted` sees a refusal-shaped output,
  produce a `Refusal` content block on the assistant message and set
  `stop_reason: "refusal"`.

### 3. Distinct failure / incomplete events

Today both `response.failed` and `response.incomplete` collapse into
`AiError.Unavailable` (or are silently dropped → `_unknown`). The spec
distinguishes them.

- **`response.failed`** — model errored generating. Add a wire schema; map
  to a typed error. Two options:
  - New `AiError.GenerationFailed` variant (cleaner for `Stream.catchTag`)
  - Or extend `AiError.Unavailable` with `subtype: "generation"` (less
    surface area)
  Lean: new variant. The fail/retry semantics are different from transport
  unavailability.
- **`response.incomplete`** — content_filter, max_output_tokens,
  max_tool_calls, etc. Should produce a `turn_complete` with `stop_reason`
  reflecting the reason. Today only `max_tokens` lands via
  `incomplete_details` on `response.completed`. Need to:
  - Model the `response.incomplete` SSE event (carries
    `incomplete_details.reason`).
  - Map reason codes to `StopReason`. New `StopReason` values likely needed:
    `"content_filter"`, `"max_tool_calls"` (in addition to `"refusal"` from
    above and existing `"max_tokens"`).
  - Emit `turn_complete` with the assembled `Turn` and the right
    `stop_reason`.

### 4. Structured outputs (`text.format`)

The most-requested feature we don't yet model. Today users put a JSON-shape
hint in the prompt and pray.

**`ResponsesRequestOptions`** gains:

```ts
readonly responseFormat?:
  | { readonly type: "text" }
  | { readonly type: "json_object" }
  | {
      readonly type: "json_schema"
      readonly name: string
      readonly description?: string
      readonly schema: object
      readonly strict?: boolean
    }
readonly verbosity?: "low" | "medium" | "high"
```

Encoder writes them as `text.format` + `text.verbosity` in the wire body.

**Sibling helper** matching `Tool.fromEffectSchema`:

```ts
ResponseFormat.fromEffectSchema(schema, { name, description?, strict? })
  : { type: "json_schema", name, description?, schema: <generated>, strict? }
```

Lives in `@effect-uai/core/ResponseFormat` (new module). Calls into
Effect's `JSONSchema.make` (or our existing converter). Strict mode toggles
schema additionalProperties / required-completeness.

**Out of scope here**: a parallel API on Anthropic/Gemini. Both have
structured-output equivalents but wire them differently — separate effort.

## Outstanding Tier 2 — provider-hosted tools

Each tool is an opt-in entry on the request `tools[]` array, produces a
typed `*_call` output item, and emits its own SSE event family. The
implementation pattern is the same for each:

1. Add `*_call` variant to `Items.Item` union.
2. Add the tool's `tools[]` entry shape to `ResponsesRequestOptions.tools`.
   Currently tools are `ToolDescriptor` (function only). Generalise to
   accept a tagged union: `FunctionTool | WebSearchTool | FileSearchTool |
   ...`.
3. Model the SSE events in `streamEvents.ts`. Each tool has
   `.in_progress` / `.completed` (and tool-specific intermediate events
   like `.searching`, `.executing`).
4. Wire to a canonical `tool_result { tool, result, isError }` event on
   `TurnEvent` (new variant — step 5 of the LLM redesign).
5. Round-trip via `providerData` until typed shapes are designed; lift to
   typed once the user-facing demand is concrete.

### Ship order within Tier 2

**5a. `tool_result` canonical variant.** Add to `TurnEvent` first, even
before any wire support. Shape:

```ts
| {
    readonly type: "tool_result"
    readonly call_id: string
    readonly tool: string         // discriminator: "web_search" | "file_search" | ...
    readonly result: unknown      // typed by tool; shape lives in Items
    readonly isError: boolean
  }
```

Discriminator on `tool` lets future canonical refinement pick into
typed shapes per provider-hosted tool without breaking existing matches.

**5b. Web search.** Most universally useful starting point.
- `Items.WebSearchCall` item type (with `id`, `status`, `query?`, `results?`).
- `tools[]` entry: `{ type: "web_search" }` (plus optional config like
  `user_location`, `search_context_size`).
- SSE events: `response.web_search_call.in_progress`,
  `response.web_search_call.searching`, `response.web_search_call.completed`.
- `tool_result` emit on `.completed`.

**5c. File search.** Same shape as web_search; results are file matches.
- `Items.FileSearchCall` item type.
- `tools[]` entry: `{ type: "file_search", vector_store_ids: ... }`.
- Same SSE event triple.

**5d. Code interpreter.** Generates outputs (text, files, images).
- `Items.CodeInterpreterCall` item type with `code` + `outputs`.
- `tools[]` entry: `{ type: "code_interpreter" }`.
- SSE: `.in_progress`, `.executing`, `.completed`. Plus
  `response.code_interpreter_call_code.delta` for streaming the generated
  code (canonical: forward as `_unknown` initially, or surface as a
  bespoke `code_delta` if recipe demand justifies).

**5e. Image generation.** Streams partial images; final output is an
image item. Touches `image_part` on `TurnEvent` (step 5 of LLM redesign).
- `Items.ImageGenerationCall` item type.
- `tools[]` entry: `{ type: "image_generation", ... }`.
- Wire: SSE event taxonomy not enumerated in spec excerpt; verify
  empirically.

**5f. MCP.** Bridges to Model Context Protocol servers. Multiple item
types.
- `Items.McpCall`, `Items.McpListTools`, `Items.McpApprovalRequest`.
- `tools[]` entry: `{ type: "mcp", server_url, ... }`.
- SSE: `.in_progress` / `.completed`. Approvals likely need a separate
  in-loop callback path — design open.

**5g. Computer use.** Visual + action loop. The most complex.
- `Items.ComputerCall` / `ComputerCallOutput`.
- `tools[]` entry: `{ type: "computer_use_preview", ... }`.
- Round-trip the `output.image_url` (screenshot) via `include[]`.

**5h. Custom tools.** User-defined tool slugs.
- `Items.CustomToolCall`.
- `tools[]` entry: `{ type: "<slug>:<name>", ... }`.
- SSE: `custom_tool_call_input.delta` / `.done`.

### `include[]` parameter

Add to `ResponsesRequestOptions`:

```ts
readonly include?: ReadonlyArray<
  | "reasoning.encrypted_content"
  | "message.output_text.logprobs"
  | "file_search_call.results"
  | "code_interpreter_call.outputs"
  | "computer_call_output.output.image_url"
>
```

Each `include` key gates a Tier-2 capability. Ship `include[]` lockstep
with the first capability that needs it (`file_search_call.results` is
the most likely first user — file search without results is useless).

## Recommended ship order across this plan

Each step independently shippable; no breaking changes in the user-facing
shapes (`Items` and `TurnEvent` only grow).

1. **Multimodal input** — `input_image` first. One PR, additive on
   `Items.ContentBlock` + Responses encoder + helper constructor.
   Anthropic encoder follow-up; Gemini encoder follow-up.
2. **Refusal completeness** — `Refusal` content block, `StopReason: "refusal"`,
   model `response.refusal.done`.
3. **`response.failed` / `response.incomplete`** — typed error +
   `StopReason` extensions. Pair with refusal in one PR if the new stop
   reasons land together.
4. **Structured outputs** — `text.format` option +
   `ResponseFormat.fromEffectSchema` helper.
5. **`tool_result` canonical variant** — `TurnEvent` extension + types
   only. Wire support lands per provider-hosted tool.
6. **First provider-hosted tool: web search** — wire schema, item type,
   `tools[]` entry, projector.
7. **`include[]`** — gate on the first capability that needs it
   (likely `file_search`).
8. **Remaining provider-hosted tools** in priority order: file_search,
   code_interpreter, image_generation, mcp, computer_use_preview, custom.
9. **`input_file`** for multimodal — when image-only proves insufficient.

## Open questions

- **`StopReason` literal expansion**. We currently have
  `"stop" | "tool_calls" | "max_tokens"`. Adding `"refusal"`,
  `"content_filter"`, `"max_tool_calls"` is straightforward but each new
  value forces consumers' exhaustive matches to update. Do we want to
  group them (`"refused"` umbrella) or keep granular? Lean: granular —
  recipes like multi-model fallback want to discriminate
  `content_filter` from `max_tokens`.
- **Tool descriptor union**. `ToolDescriptor` is currently the function
  shape. To accept provider-hosted tools we need a tagged union. Risk of
  breaking the `Tool.executeAll` signature — existing function tools
  must still work the same. Likely path: keep `ToolDescriptor` as
  function-only; add a separate `ProviderHostedTool` slot on
  `ResponsesRequestOptions.tools` that's Responses-specific.
- **Round-tripping `*_call` items as history**. For
  `previous_response_id`-style continuation the server holds tool
  results, but for stateless continuation the user must round-trip
  them. Their shapes are richer than `function_call_output`. Lean:
  give each tool its own `*_call_output` item type, encode via
  `providerData` for unrecognised shapes. (Same open question called
  out in responses-gaps.md.)
- **MCP approvals**. Approvals are a control-flow concern, not a result.
  They likely warrant a separate canonical event
  (`approval_required { id, ... }`) and a resume hook on the loop body.
  Design open; defer past the MCP basics.
- **Code interpreter code-delta**. The streamed `code_interpreter_call_code.delta`
  is potentially useful UX (streaming the model's code as it runs).
  Either canonical-ize as `code_delta` or surface only via `streamNative`.
  Lean: only via `streamNative` until a concrete recipe asks for it.
