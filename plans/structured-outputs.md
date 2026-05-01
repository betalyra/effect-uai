# Plan — Structured outputs

Pulled out of [responses-tier12.md](responses-tier12.md) item 4 because the
design is more involved than "set a wire field". The spirit of this doc:
get structured outputs *right* so consumers don't reproduce the
Vercel-AI-SDK trap of "type-cast and pray".

## Goals

1. **Real runtime validation.** The model's output is parsed AND validated
   against the user's schema. Validation failures surface as typed errors,
   not silently-coerced `any`.
2. **Validator-agnostic.** Works with Effect `Schema`, Zod, ArkType,
   Valibot, or anything else. Users don't have to switch libraries.
3. **Streaming via line accumulation.** When the user prompts the model
   to emit one JSON object per line (JSONL), each completed line is
   parsed, validated, and emitted. No partial-JSON parser, no
   `DeepPartial`, no type-cast. The same primitive composes with CSV or
   any other newline-delimited format. **Note**: no provider supports
   JSONL natively; the convention is enforced via prompting, not via a
   schema. See "Why we don't ship JSON-array element streaming" below.
4. **Provider-portable.** Every major provider that supports streaming +
   structured output streams it as text fragments. The composition is
   uniform; no per-provider quirks leak into user code.

## Non-goals

- A new schema library. We ride on what exists.
- Coercion / repair on validation failure. If the model produces invalid
  JSON we fail loudly; recovery is the consumer's choice (see
  `recipes/validation-retry`).
- **Streaming a single object's fields as they arrive (Vercel
  `partialObjectStream`-style).** That requires a partial-JSON parser
  with type casts on partial values; the type lies under the hood. If a
  user genuinely needs this, they tap the raw `text_delta` stream and
  run their own parser. We don't bake it in.
- **Server-enforced JSON-array element streaming (Vercel
  `elementStream`-style).** Schema-as-array + an incremental
  JSON-token parser that detects element boundaries. Cleaner than
  partial-object streaming (each emitted element is fully validated,
  no type cast) but introduces a JSON tokenizer with non-trivial
  complexity. We rely on prompted JSONL instead. See "Why we don't
  ship JSON-array element streaming" below.
- Structured-output streaming on providers that don't support both at
  the same time (xAI Grok). Fall back to non-streaming there.

## Provider landscape (verified May 2026)

| Provider | Native JSON Schema | Streaming + structured both work? | Wire shape during streaming |
| --- | --- | --- | --- |
| **OpenAI Responses** | Yes (`text.format = { type: "json_schema", strict: true }`) | Yes | `response.output_text.delta` — text fragments |
| **Anthropic** | Yes (added Nov 2025: `output_config.format = { type: "json_schema" }`, beta header `structured-outputs-2025-11-13`) | Yes | `content_block_delta` with `text_delta` — text fragments |
| **Google Gemini** | Yes (`responseJsonSchema` + `responseMimeType: "application/json"`, Gemini 3 series) | Yes | `text` parts — text fragments |
| **Mistral** | Yes (`response_format = { type: "json_schema", strict: true }`) | Yes | text deltas (OpenAI-style SSE) |
| **Cohere** | Partial (`response_format = { type: "json_object", schema?: ... }`, Command R/R+) | Yes | text deltas |
| **xAI Grok** | Yes for non-streaming | **No — mutually exclusive with `stream: true`** | n/a |
| **DeepSeek** | Only `json_object` mode (no schema enforcement) | Yes (json_object only) | text deltas |

**Key takeaway**: every provider that supports streaming + structured
output streams it as **text fragments**. The composition
"`text_delta` → `accumulateLines` → parse → validate" is provider-agnostic.

The previous draft of this plan assumed Anthropic still required a
tool-cheat workaround. That changed in November 2025 when Anthropic
shipped native structured outputs. The plan reflects current reality.

## Typesafety end-to-end

Non-negotiable: paste a schema, get inferred types all the way through.
The user never writes `as MyType` or fights type parameters.

```ts
// Effect Schema
const Person = Schema.Struct({ name: Schema.String, age: Schema.Number })
const format = StructuredFormat.fromEffectSchema(Person, { name: "Person" })
//    ^? StructuredFormat<{ readonly name: string; readonly age: number }>

// Zod
const Person = z.object({ name: z.string(), age: z.number() })
const format = StructuredFormat.fromZodSchema(Person, { name: "Person" })
//    ^? StructuredFormat<{ name: string; age: number }>

// Valibot (via Standard Schema)
const Person = v.object({ name: v.string(), age: v.number() })
const format = StructuredFormat.fromStandardSchema(Person, { name: "Person" })
//    ^? StructuredFormat<{ name: string; age: number }>
```

The type parameter `A` flows through every consumer:

```ts
// Final-only validated decode
const turn = yield* Turn.collect(streamTurn(history, { structured: format }))
const value = yield* Turn.toStructured(turn, format)
//    ^? Person   - inferred from `format`, not cast

// Streaming items (recipe composition)
yield* streamTurn(history, { structured: format }).pipe(
  textDeltas,
  accumulateLines,
  decodeJsonLines(format),
  Stream.runForEach((person) => ui.append(person)),
  //                ^? Person
)
```

Constraints this places on the design:

1. **Adapter signatures preserve `A`.** Each `from*Schema` is generic and
   pulls `A` directly from the input schema's static type. No `unknown`
   intermediate.
   ```ts
   const fromEffectSchema:    <A, I>(s: Schema.Schema<A, I>, opts) => StructuredFormat<A>
   const fromZodSchema:       <A>(s: z.ZodType<A>, opts)            => StructuredFormat<A>
   const fromStandardSchema:  <A>(s: StandardSchemaV1<unknown, A>, opts) => StructuredFormat<A>
   ```
2. **Helpers thread `A`.** `Turn.toStructured(turn, format)` returns
   `Effect<A, ...>`. `decodeJsonLines(format)` returns
   `Stream<A, JsonParseError | StructuredDecodeError, ...>`.
3. **No widening at the option boundary.** Provider options carry
   `structured?: StructuredFormat<unknown>` (provider options can't
   reasonably be generic). The typed entry points — `Turn.toStructured`,
   `decodeJsonLines` — preserve `A` end-to-end.

Standard Schema (the spec at standardschema.dev) is the cross-library
contract: `interface StandardSchemaV1<Input, Output>` with the output
type as the second parameter. Zod 3.24+, Valibot, ArkType, and others
implement it.

## The cross-cutting type

Validation libraries don't share a JSON-Schema generator, but they do
agree on "I have a thing that accepts `unknown` and returns either the
typed value or an error". The user-facing record bundles both halves:

```ts
export interface StructuredFormat<A> {
  /** Stable identifier; passed to providers as the schema name. */
  readonly name: string
  readonly description?: string
  /** Generated JSON Schema; provider-specific encoders use this. */
  readonly jsonSchema: object
  /** Runtime decoder. Owns the validation contract. */
  readonly decode: (raw: unknown) => Result.Result<A, StructuredDecodeError>
  /** OpenAI / Mistral / Anthropic strict-mode constraints flag. Other providers ignore. */
  readonly strict?: boolean
}

export class StructuredDecodeError extends Data.TaggedError("StructuredDecodeError")<{
  readonly raw: string
  readonly issues: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>
    readonly message: string
  }>
}> {}
```

No `decodePartial`. No `DeepPartial<A>`. The streaming story is
"complete validated values, one at a time" via line accumulation, not
"partial values during a single object's generation".

This shape lives in `@effect-uai/core/StructuredFormat` so every provider
package and recipe can consume it.

## Per-library adapters

Each adapter produces a `StructuredFormat<A>` from that library's native
schema:

```ts
// @effect-uai/core/StructuredFormat — Effect is already a workspace dep
StructuredFormat.fromEffectSchema(schema: Schema.Schema<A, I>, options): StructuredFormat<A>

// @effect-uai/structured-zod — peer-deps zod + zod-to-json-schema
fromZodSchema(schema: z.ZodType<A>, options): StructuredFormat<A>

// @effect-uai/structured-standard-schema — covers Valibot, ArkType, Zod 3.24+
fromStandardSchema(schema: StandardSchemaV1<unknown, A>, options): StructuredFormat<A>
```

Why split into packages: each adapter pulls in its library's JSON-Schema
generator, which is non-trivial weight. Users only install what they
use. `fromEffectSchema` sits in core because Effect is already a
workspace dep.

Adapters are responsible for:

1. Generating JSON Schema (Effect `JSONSchema.make`, Zod
   `zod-to-json-schema`, etc.).
2. Wrapping the library's parser as `decode`, mapping its native error
   format to `StructuredDecodeError`.

## Wire format (per provider)

| Provider | Wire shape | Notes |
| --- | --- | --- |
| OpenAI Responses | `text.format = { type: "json_schema", name, schema, strict }` | Default (omit) = free text. Strict mode is server-enforced via constrained decoding. |
| Anthropic | `output_config.format = { type: "json_schema", schema }` + beta header `structured-outputs-2025-11-13` | Native as of Nov 2025. Streams as `text_delta`. |
| Google Gemini | `generationConfig.responseJsonSchema` (or `responseSchema`) + `responseMimeType: "application/json"` | Available on Gemini 3 series. |
| Mistral | `response_format = { type: "json_schema", strict: true, json_schema: {...} }` | OpenAI-compatible shape. |
| Cohere | `response_format = { type: "json_object", schema?: ... }` | Schema is optional; without it the model returns any valid JSON. |
| xAI Grok | `response_format = { type: "json_schema", json_schema: {...} }` | **Doesn't combine with streaming.** Use non-streaming `make` style; for streaming, fall back to `json_object` or no constraint. |
| DeepSeek | `response_format = { type: "json_object" }` | No schema-level enforcement. Validation is strictly client-side. |

Each provider's options surface gains an optional
`structured?: StructuredFormat<unknown>`. Encoders pull `jsonSchema` and
write the wire shape; consumers read `decode` to validate.

For xAI: the request encoder should detect `structured` + `stream: true`
and either error out with a clear message or transparently downgrade to
`json_object` (logging a warning). Lean: error out — silent downgrade
hides the constraint loss.

## The two streaming paths

Two genuinely different use cases. Neither one is "watch a single
object's fields appear live" — that's the partial-JSON trap we don't
take.

### Final-only

Wait for the turn to complete, validate the assembled output once. This
is what most production code does in practice: structured-output
responses are typically sub-second, the streaming UI value is marginal.

```ts
const turn = yield* Turn.collect(streamTurn(history, { structured: format }))
const value = yield* Turn.toStructured(turn, format)
//    ^? Person — typed, validated
```

`Turn.toStructured` is the only library helper this needs. It:

1. Concatenates `output_text` content blocks on the last assistant
   message.
2. Fails with `RefusalRejected` if the message has a `refusal` content
   block instead.
3. Runs `JSON.parse` (failing with `JsonParseError`).
4. Runs `format.decode` (failing with `StructuredDecodeError`).

### Streaming items (line accumulation, prompt-driven JSONL)

**Important context**: no provider supports JSONL natively. A schema can
only describe a single value (one object, or one array). To stream items
incrementally, the user prompts the model to emit one JSON per line
(JSONL convention). Compliance is up to the model — it usually follows
direct instructions, but it's not server-enforced.

The trade-off: we get format flexibility (JSONL today, CSV tomorrow,
anything line-delimited) at the cost of zero schema enforcement on the
wire. Validation is purely client-side. For tightly schema-bound
streaming we'd need server-enforced array element streaming (see "Why
we don't ship JSON-array element streaming" below).

The composition is five lines of stream operators:

```ts
streamTurn(history, { structured: format }).pipe(
  textDeltas,                  // TurnEvent stream → string stream
  accumulateLines,             // string stream → complete-line stream
  decodeJsonLines(format),     // complete-line stream → validated A stream
  Stream.runForEach(handler),
)
```

All four operators are library primitives (small, focused). The
composition is a recipe, not a primitive — see "Recipe-only streaming"
below.

The `decodeJsonLines` step is the natural composition of "JSON.parse
then format.decode" exposed as a single stream operator. Library
primitive worth shipping because it's used everywhere.

The same skeleton works for non-JSON formats by swapping the per-line
parser:

```ts
// JSONL (default)
streamTurn(...).pipe(textDeltas, accumulateLines, decodeJsonLines(format), ...)

// CSV
streamTurn(...).pipe(
  textDeltas,
  accumulateLines,
  Stream.mapEffect((line) => pipe(parseCsvRow(line), Result.flatMap(format.decode))),
  ...,
)

// Anything else line-delimited
streamTurn(...).pipe(
  textDeltas,
  accumulateLines,
  Stream.mapEffect((line) => userParser(line)),
  ...,
)
```

The schema describes the *value shape*, not the wire format. The parser
slot handles the wire-format variation.

## Recipe-only streaming

We deliberately do **not** ship a `streamStructured` / `streamObjects`
primitive. Reasons:

1. **The composition is short and provider-agnostic.** Every major
   provider streams structured output as text deltas (per the matrix
   above). One uniform pipeline; no quirks to encapsulate. A primitive
   wouldn't earn its surface area.
2. **Error policy is application-specific.** Fail-fast vs. permissive
   vs. sample-and-warn vs. partial-output-preserving — these are real
   production policies and each is correct in different contexts. A
   library primitive has to pick one (or grow an option bag that still
   doesn't cover all four). Recipes show the composition + the error
   handling explicitly so users see what they're choosing.
3. **`StructuredItem<A>` doesn't belong in `TurnEvent`.** `TurnEvent` is
   wire-derived events (what the provider emitted, projected to
   canonical form). Validated items are consumer-side derivations. If a
   recipe wants a tagged event shape, it constructs one in user code:
   `Stream.map(item => ({ type: "item", value: item }))`. The library
   doesn't pollute `TurnEvent` with synthesised variants.

What this gives us instead:

- **Library primitives** (small, composable, no policy choices):

  ```ts
  // @effect-uai/core
  StructuredFormat<A>                              // type
  StructuredFormat.fromEffectSchema(schema, opts)  // adapter
  StructuredDecodeError                            // tagged error
  parseJson(format)                                // string → Result<A>
  decodeJsonLines(format)                          // Stream<string> → Stream<A>
  Turn.toStructured(turn, format)                  // Turn → Effect<A>
  accumulateLines, accumulateLinesWithFlush        // string streams → line streams
  textDeltas                                       // TurnEvent stream → string stream
  ```

- **Recipes** in `recipes/structured-output/`:

  ```
  recipes/structured-output/
    README.md              # overview + when to use which pattern
    single.ts              # streamTurn + Turn.toStructured
    line-items.ts          # streamTurn + textDeltas + accumulateLines + decodeJsonLines
    csv-rows.ts            # same skeleton, parseCsvRow as the per-line parser
    validation-retry.ts    # catch StructuredDecodeError, feed issues back, retry
    error-policies.ts      # fail-fast / skip-bad / sample-and-warn variants side-by-side
  ```

Each recipe is ~30 lines of runnable code. Users copy the pattern they
want into their app. No `import { streamStructured }` line; no option
bag to litigate.

## Error handling

This is the section that vindicates the recipe approach. Streaming
multiple validated items has at least four distinct policies, and each
is correct for some use case:

- **Fail-fast.** One bad line aborts. Strict pipelines, audit logs.
  ```ts
  pipeline.pipe(Stream.runForEach(handler))   // fails on first bad line
  ```
- **Skip-bad.** Drop failures, keep collecting. Best-effort scrapers.
  ```ts
  pipeline.pipe(
    Stream.catchTag("StructuredDecodeError", () => Stream.empty),
    Stream.catchTag("JsonParseError",        () => Stream.empty),
    Stream.runForEach(handler),
  )
  ```
- **Sample-and-warn.** Log first N failures, keep going. Production
  telemetry.
  ```ts
  pipeline.pipe(
    Stream.catchAll((err) =>
      Stream.unwrap(Effect.gen(function* () {
        yield* Effect.logWarning(`bad line: ${String(err)}`)
        return Stream.empty
      })),
    ),
    Stream.runForEach(handler),
  )
  ```
- **Surface failures as data.** Emit success-or-failure values into the
  stream as a tagged union; downstream picks. Interactive UIs that want
  to render "this row failed".
  ```ts
  pipeline.pipe(
    Stream.either,                           // Stream<Either<Err, A>>
    Stream.runForEach((either) =>
      Either.match(either, { onLeft: showError, onRight: handler }),
    ),
  )
  ```

A library `streamStructured(...)` primitive forced to pick one of these
makes wrong choices for users in the other three groups. The recipe
shows them side-by-side; users pick what fits.

## Verbosity

`verbosity` is **not** related to structured outputs and shouldn't share
a field. OpenAI Responses `text.verbosity ∈ "low" | "medium" | "high"`
controls answer length / level of detail (introduced with GPT-5; some
older models ignore). Lives as a separate top-level field on
`ResponsesRequestOptions`. Encoder merges it into the wire's `text`
object alongside `format`.

## Default behaviour and the union question

Three real wire-format states for OpenAI Responses (and similar for
Mistral, Cohere):

1. Free text (the default — omit `text.format` entirely).
2. Any JSON (`text.format = { type: "json_object" }` — model emits valid
   JSON but schema-free).
3. Schema-constrained JSON (`text.format = { type: "json_schema", ... }`).

We **don't** model state 1 explicitly. `responseFormat` is optional;
absent = free text. Two provider-options surfaces:

```ts
// Schema-driven (the 90% case)
readonly structured?: StructuredFormat<unknown>

// Free-form JSON (no schema, just "give me JSON")
readonly responseFormat?: { readonly type: "json_object" }
```

Two fields, but each does exactly one thing. If both are set,
`structured` wins (it's strictly stronger).

Alternative: collapse into one `responseFormat` union with `json_object |
StructuredFormat<unknown>`. Possibly cleaner; settle before shipping.

## Validation failure on `Turn.toStructured`

If `decode` fails on the final output, `Turn.toStructured` returns
`Effect.fail(StructuredDecodeError)`. Consumers choose to retry, surface,
or fall back via standard `Effect.catchTag`.

The `recipes/validation-retry` recipe shows the canonical retry loop:
catch the error, append the bad JSON output + a "the JSON failed
validation because <issues>" assistant nudge, run another turn.
Two-iteration budget by default.

## Phased rollout

Each step independently shippable; nothing breaks existing callers.

1. **Library primitives in core.** `StructuredFormat<A>`,
   `StructuredDecodeError`, `fromEffectSchema`, `parseJson(format)`,
   `decodeJsonLines(format)`, `Turn.toStructured(turn, format)`,
   `accumulateLines`, `accumulateLinesWithFlush`, `textDeltas`. One PR.
2. **Responses wire support**: `structured?` and `responseFormat?` /
   `verbosity?` on `ResponsesRequestOptions`; encoder writes
   `text.format` + `text.verbosity`.
3. **Anthropic wire support**: `structured?` on `AnthropicRequestOptions`;
   encoder writes `output_config.format` + the
   `anthropic-beta: structured-outputs-2025-11-13` header. `text_delta`
   path is already wired.
4. **Gemini wire support**: `structured?` on `GeminiRequestOptions`;
   encoder writes `generationConfig.responseJsonSchema` +
   `responseMimeType`.
5. **Recipes** at `recipes/structured-output/`:
   `single.ts`, `line-items.ts`, `csv-rows.ts`,
   `validation-retry.ts`, `error-policies.ts`. With a
   walkthrough README.
6. **`fromZodSchema` adapter package** (`@effect-uai/structured-zod`).
7. **`fromStandardSchema` adapter package**
   (`@effect-uai/structured-standard-schema`) — covers Valibot,
   ArkType, Zod 3.24+ via the Standard Schema spec.
8. **Cross-provider concerns**: figure out xAI's
   streaming-vs-structured exclusivity (clear error message at request
   prep), document DeepSeek's `json_object`-only constraint, add Mistral
   / Cohere / xAI / DeepSeek provider packages as separate efforts.

## Open questions

- **Single `responseFormat` union vs. split `structured` +
  `responseFormat` fields.** Decide before shipping step 2.
- **xAI's streaming + structured exclusivity.** Error or warn-and-downgrade?
  Lean: error with a clear message; users opt into either streaming or
  structured explicitly.
- **Cohere schema enforcement.** Their `json_object` mode accepts an
  optional schema; we treat it as a constraint hint client-side.
  Document that `strict: true` is meaningless on Cohere.
- **Where does `verbosity` actually belong?** It's Responses-specific
  today, but GPT-5-style "answer effort" is a concept that may
  generalise. Lean: keep it on `ResponsesRequestOptions` for now, lift
  to a common option if Anthropic / Gemini ship analogues.
- **Adapter packaging.** New `@effect-uai/structured-*` packages or
  single `@effect-uai/structured` with subpath exports per library?
  Lean: separate packages, smaller install footprint.
- **What's the "assistant text" for `Turn.toStructured`?** A turn may
  have multiple message items, each with multiple content blocks.
  Concatenate `output_text` on the last assistant message? First
  message's first block? Lean: concatenate all `output_text` on the
  last assistant message. Refusals short-circuit to a `RefusalRejected`
  failure tag.

## Why not just "reuse `Tool.fromEffectSchema`"

A tool descriptor is structurally close to what structured outputs need
— both have `name`, `description`, JSON Schema, decoder. Tempting to
share. But:

1. Tools have a *handler* — an Effect that runs server-side. Structured
   outputs have a *decoder*. Different semantics.
2. Tool calls round-trip through `function_call` items; structured
   outputs round-trip through `output_text` (or `refusal`). Different
   wire shapes.

Keep them separate, with `StructuredFormat` and `Tool` as siblings.

## Why we don't ship a partial-JSON streaming primitive

The Vercel AI SDK does this via `partialObjectStream` / `parsePartialJson`.
Looks magical, but:

- The partial values are **type-cast, not validated**. Vercel's runtime
  trusts the partial parser's output and labels it `DeepPartial<T>`. If
  the parser misinterprets a fragment, the type lies until the consumer
  crashes.
- Validating partials properly requires schema-library cooperation we
  don't have in JS (Pydantic-style partial mode). Zod's `.partial()`
  produces a separate schema instance with no notion of "definitely
  complete vs. still streaming"; ArkType, Valibot, Effect Schema all
  similarly lack a built-in partial-validation mode.
- The use case is narrow (live UI updates on a single object) and the
  alternative is fine: wait for `structured_complete`, or for power
  users, tap raw `text_delta`s and run their own parser.

If we ever want to support this anyway, it lives as a **separate**
optional package (`@effect-uai/structured-partial`) so the core surface
stays small and the type-cast trade-off is opt-in. Not part of v1.

## Why we don't ship JSON-array element streaming

Vercel's AI SDK has a second streaming mode beyond `partialObjectStream`:
`elementStream` (their array output mode). It's the cleaner of the two —
each emitted element is fully validated, no `DeepPartial` type cast.
Mechanism: bind the schema to a JSON array, then run a JSON-token-aware
parser on the streaming text that detects element boundaries inside
the array and emits each completed object.

Properly enforced server-side, properly typed client-side. Why are we
not shipping it?

- **Implementation cost.** A correct streaming JSON tokenizer needs to
  track string state, escape sequences, brace/bracket depth across
  arbitrary nesting, and whitespace handling. ~100 lines of careful
  state-machine code with non-obvious edge cases (escaped quotes
  inside strings, nested arrays, unicode). Either we own and test
  that, or we add a runtime dep on `stream-json` / `clarinet` /
  similar. Both are real costs.
- **Format inflexibility.** The element streamer is JSON-array-shaped.
  No CSV, no log lines, no custom delimiters. Path A (line
  accumulation) covers all three for the same five lines of recipe
  code.
- **Marginal benefit over Path A in practice.** Models are very
  cooperative with "emit one JSON per line, no surrounding array"
  prompts. The prompted-JSONL path produces the same emit-per-item
  experience as `elementStream`, with worse server enforcement but
  much smaller surface.
- **It's two paths to the same place.** Shipping both `accumulateLines`
  AND `streamJsonArrayElements` doubles the surface we have to
  document, test, and tell users to choose between, for a difference
  that mostly matters when a model misbehaves under a JSONL prompt.

If demand for server-enforced array element streaming materialises,
we ship it as a separate primitive (`streamJsonArrayElements(format)`)
without changing the existing surface. Until then, prompted JSONL +
line accumulation handles the use case at much lower complexity.
