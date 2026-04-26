# Plan — OpenAI Responses API provider + experiment

Goal: an `experiments/responses.ts` runnable via `tsx` that drives a real
`gpt-5.4-mini` Responses API conversation through our `Stream.paginate`
loop, with text + reasoning + tool calls. Plus a real
`src/providers/openai/Responses.ts` provider Layer.

This is a discussion artifact, not a prescription. Resolve the open
questions first, then implement in the order at the bottom.

---

## Confirmed scope

- **Transport**: `effect/unstable/http`'s `HttpClient` with the
  `FetchHttpClient` Layer on Node.
- **Auth**: `OPENAI_API_KEY` via `Effect.Config.string`.
- **Model**: `gpt-5.4-mini`. Always reasons a little — reasoning support
  is required, not optional.
- **Tool**: `get_current_time({ timezone })` via `Intl.DateTimeFormat`.
- **User prompt**: *"What time is it in Lisbon and Tokyo right now?"* —
  forces parallel tool calls.
- **Output**: `Effect.logDebug` per delta, pretty-printed; print every
  stream element.
- **Loop**: `Stream.paginate` directly in the experiment, no helper.
- **Errors**: translate non-2xx + SSE error events into `AiError`. No
  retry / rate-limit awareness in this iteration.
- **Out of scope**: web_search, file_search, computer_use, structured
  output, audio, image, batch APIs, prompt caching, `previous_response_id`.

---

## Q1 — request options and per-provider type safety

### The problem

The provider must send `tools`, `toolChoice`, `temperature`,
`reasoning.effort`, etc. to OpenAI in the request body. Our current
`streamTurn(history): Stream<TurnDelta>` has nowhere for these. And we
want OpenAI-only options (`reasoning.effort`) to be a type error against
a non-OpenAI tag.

### What v4 gives us

`Context.Service` in v4 is **concrete-shape only** — services aren't
type-parameterized. (Confirmed against `effect-smol`. v3 guidance held.)
So we can't write `LanguageModelService<O>`. Each provider must register
its own service tag with its own concrete shape.

### The shape

A common request-options type for the cross-provider subset, plus a
per-provider concrete options type. Each provider has its own concrete
service tag.

```ts
// Common, cross-provider knobs. Lives in framework.
interface CommonRequestOptions {
  readonly tools?: ReadonlyArray<ToolDescriptor>
  readonly toolChoice?: "auto" | "required" | "none" | { name: string }
  readonly temperature?: number
  readonly maxOutputTokens?: number
}

// Generic tag — works with any provider. Code that yields LanguageModel
// is provider-portable.
class LanguageModel extends Context.Service<LanguageModel, {
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: CommonRequestOptions
  ) => Stream<TurnDelta, AiError>
}>()("@betalyra/effect-uai/LanguageModel") {}
```

Provider-specific options extend the common type and live next to the
provider's own service tag:

```ts
// src/providers/openai/Responses.ts
interface OpenAiRequestOptions extends CommonRequestOptions {
  readonly reasoning?: { readonly effort: "low" | "medium" | "high" }
  readonly store?: boolean
  readonly previousResponseId?: string                // not used in this experiment
}

class OpenAi extends Context.Service<OpenAi, {
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: OpenAiRequestOptions
  ) => Stream<TurnDelta, AiError>
}>()("@betalyra/effect-uai/providers/openai/Responses") {}
```

The provider's `layer` registers **both tags** with the same
implementation:

```ts
namespace OpenAiResponses {
  export const layer = (cfg: Config): Layer<LanguageModel | OpenAi> =>
    Layer.effect(OpenAi, makeService(cfg)).pipe(
      Layer.merge(Layer.effect(LanguageModel, makeService(cfg)))
    )
}
```

### DX at the call site

```ts
// Provider-portable — only common options accepted
turn(history, { tools, toolChoice: "auto" }).pipe(...)
//  ^  yields LanguageModel internally

// OpenAI-typed — full options surface accepted
OpenAi.use((m) =>
  m.streamTurn(history, { tools, reasoning: { effort: "high" } })
)
//                          ^^^^^^^^^ ✓ OpenAI tag accepts this

// Compile error — generic tag rejects OpenAI-only field
turn(history, { reasoning: { effort: "high" } })   // ✗
```

### Pros and cons

**Pros**:
- Type-safe per provider, no global enum or union of provider names.
- Generic `LanguageModel` tag still works for portable code.
- Adding a new provider is local — declare a service tag with a
  provider-specific options shape; register both tags in the Layer.
- Uses only Effect's existing primitives — no parametric services.

**Cons**:
- Provider-aware code requires the provider's tag in `R`, not just
  `LanguageModel`. Mildly more verbose than a single tag, but it's the
  *correct* coupling.
- Two-tag registration in the provider Layer is one extra line per
  provider. Trivially abstracted with a small helper if it ever grows.

---

## Q2 — SSE / JSONL primitives

Generic stream primitives, no AI imports. Simple files for now.

```
src/SSE.ts
  ├── SSE.Event       — { event?: string; data: string; id?: string }
  ├── SSE.fromBytes   — Stream<Uint8Array> → Stream<Event>
  └── SSE.toBytes     — Stream<Event>      → Stream<Uint8Array>

src/JSONL.ts
  ├── JSONL.fromBytes — Stream<Uint8Array> → Stream<string>
  ├── JSONL.parse     — (schema) => Stream<string> → Stream<A>
  └── JSONL.toBytes   — Stream<A>          → Stream<Uint8Array>
```

The OpenAI provider uses `SSE.fromBytes`. The Phase-3 cuttlekit recipe
("stream JSONL with validation") uses `JSONL.parse(MyResponseSchema)`.

Tests use `Stream.fromIterable(...bytes)`. Deterministic, no network.

---

## Q3 — provider-specific data on Items

### The shape

Framework `Item` types carry only the genuinely-cross-provider subset.
Each provider tucks its native shape into a single opaque `providerData`
field, which the framework preserves verbatim and never interprets.
There is no provider name registry, no enum, no discriminated union.

```ts
// src/Items.ts — framework, generic, stable
const Reasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),         // human-readable, for UI/metrics
  signature: Schema.optional(Schema.String),       // opaque round-trip blob
  providerData: Schema.optional(Schema.Unknown)    // provider's native shape, untouched
})
```

What goes in each common field:

| Field | Source for OpenAI | Source for Anthropic |
|---|---|---|
| `id` | `item.id` | `item.id` |
| `summary` | concatenation of `summary[].text` | `text` |
| `signature` | `encrypted_content` | `signature` |
| `providerData` | the full original JSON object | the full original JSON object |

Same idea applies to `Message`, `FunctionCall`, `FunctionCallOutput` —
each gets an optional `providerData: unknown`. Adding new providers
never touches `src/Items.ts`.

### Reading provider data

Each provider exports its own typed reader, scoped to its module. No
framework helper.

```ts
// src/providers/openai/Reasoning.ts
import { Schema } from "effect"
import * as Items from "@betalyra/effect-uai/Items"

export const ReasoningData = Schema.Struct({
  encrypted_content: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.Array(Schema.Struct({
    type: Schema.String,
    text: Schema.String
  })))
})
export type ReasoningData = typeof ReasoningData.Type

// Decode the providerData field. Returns Either; user handles both branches.
export const reasoningData = (item: Items.Reasoning) =>
  Schema.decodeUnknownEither(ReasoningData)(item.providerData)
```

User code:

```ts
import * as OpenAi from "@betalyra/effect-uai/providers/openai"

const data = OpenAi.reasoningData(item)
if (Either.isRight(data)) {
  // typed access to OpenAI fields
  console.log(data.right.summary?.[0]?.text)
}
```

Generic code reads `item.summary`, `item.signature` and never knows or
cares which provider produced the item.

### Multi-provider conversations

If a Reasoning item is produced by OpenAI and later sent to Anthropic
(model swap), `providerData` shape doesn't match Anthropic's
expectations. The Anthropic provider sees an `unknown` `providerData`
it can't decode and does whatever its own behavior dictates (typically
ignore it — the `signature` field is what carries cross-provider
round-trip). The framework is not in this loop.

---

## Q4 — Standard Schema for tool input schemas

Effect v4 has `Schema.toStandardSchemaV1`, `Schema.toJsonSchemaDocument`,
and detects existing `~standard` properties on inputs.

### Decision

`Tool.inputSchema` is typed as `StandardSchemaV1<unknown, Input>` — any
Standard Schema implementation works (Effect Schema, Zod, Valibot,
ArkType). When rendering for OpenAI's `tools[].parameters`:

1. If the input's `~standard.jsonSchema` is set (per [PR #134](https://github.com/standard-schema/standard-schema/pull/134)),
   use it directly.
2. Else if it's an Effect Schema (detected via brand or duck-typing),
   call `Schema.toJsonSchemaDocument`.
3. Else throw — the user must provide a Standard Schema with the
   `jsonSchema` field.

The framework bundles no schema library beyond Effect Schema (which
ships with `effect`).

For the experiment, Effect Schema directly:

```ts
import { Schema } from "effect"

const GetCurrentTimeInput = Schema.Struct({
  timezone: Schema.String
})

const getCurrentTime = Tool.make({
  name: "get_current_time",
  description: "Look up the current time in a given IANA timezone.",
  inputSchema: GetCurrentTimeInput,
  run: ({ timezone }) =>
    Effect.try(() => ({
      iso: new Date().toLocaleString("en-US", { timeZone: timezone })
    })),
  strict: true
})
```

---

## Q5 — strict mode

OpenAI's "strict" tool-call mode constrains the model's JSON output to
match the JSON Schema exactly, but only accepts a restricted subset:
all properties in `required`, `additionalProperties: false`, no
`optional` (use `nullable`), limited `format`. Schemas that don't meet
the subset are rejected by OpenAI.

### Decision

`Tool.make` accepts an optional `strict` flag, **default `true`**.

```ts
interface Tool<Name, Input, Output, R> {
  readonly name: Name
  readonly description: string
  readonly inputSchema: StandardSchemaV1<unknown, Input>
  readonly run: (input: Input) => Effect<Output, unknown, R>
  readonly strict?: boolean        // default true
}
```

The framework never rewrites the user's schema. If `strict: true` and
the rendered JSON Schema is incompatible (`.optional` etc.), OpenAI
returns a 400; the user fixes their schema. No silent degradation.

`Toolkit.toDescriptors(tk)` reads each tool's `strict` flag and
includes it in the descriptor.

```ts
interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly strict?: boolean        // undefined falls back to provider default
}
```

---

## Open question — where does `reasoning.effort` live?

It's **provider-specific** (only OpenAI / Anthropic / a few others have
it; each spells it differently). So it lives in the provider's options
type, not in `CommonRequestOptions`.

```ts
// OpenAI
interface OpenAiRequestOptions extends CommonRequestOptions {
  readonly reasoning?: { readonly effort: "low" | "medium" | "high" }
}

// (later) Anthropic
interface AnthropicRequestOptions extends CommonRequestOptions {
  readonly thinking?: { readonly type: "enabled"; readonly budget_tokens: number }
}
```

Generic code can't set reasoning effort; OpenAI-typed code can. That's
the correct outcome — there's no portable abstraction over reasoning
effort right now.

---

## Implementation order

1. **`src/Items.ts`** — add `Reasoning` item type, add `providerData` to
   every Item, add `reasoning_summary_delta` to TurnDelta. Update mock
   provider so existing tests still pass.
2. **`src/SSE.ts` + `src/JSONL.ts`** — generic stream primitives, with
   their own tests (no network).
3. **`RequestOptions`** — add `CommonRequestOptions` parameter to
   `LanguageModel.streamTurn`. Update mock to accept-and-ignore.
4. **`Toolkit.toDescriptors`** — Standard Schema → JSON Schema bridge,
   honor per-tool `strict` flag.
5. **`src/providers/openai/Responses.ts`** — `OpenAi` service tag,
   `OpenAiRequestOptions`, `layer`, `make`. Internally:
   - HTTP request with `HttpClient` + `FetchHttpClient`.
   - `SSE.fromBytes` over the response body.
   - Decoder per OpenAI event name → `TurnDelta`.
   - `response.completed` → `turn_complete`.
6. **`src/providers/openai/Reasoning.ts`** — typed accessor for
   `Reasoning.providerData`.
7. **`experiments/responses.ts`** — runnable `tsx` script. `Effect.Config`
   for the API key. Define tool, build descriptors. `Stream.paginate`
   loop. `Stream.tap` logs every delta via `Effect.logDebug`.
