---
name: effect-uai-structured-output
description: Use when the user wants the model to return a typed JSON object (not prose) and have it validated locally — e.g. extracting a structured form, classifying input into a schema, returning a recipe / contact / event. One Effect Schema crosses the wire as JSON Schema and runs locally as the decoder.
license: MIT
---

# effect-uai structured-output

The model returns a typed JSON object instead of prose. One Effect
Schema is used twice: provider-side as a JSON Schema constraint, and
locally as a decoder for the assembled response.

Reach for this when the user says any of:

- "I want the model to fill out a form / return a typed object"
- "Extract entities / fields / a recipe from this input"
- "Classify this into a structured shape"

## Define the contract

```ts
import { Effect, Schema } from "effect"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"

const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})
type Recipe = typeof Recipe.Type

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)
```

`StructuredFormat.fromEffectSchema` adapts the schema for both sides
of the wire: a provider-facing JSON Schema constraint plus a local
decoder.

## One turn, typed result

```ts
const program = Effect.gen(function* () {
  const lm = yield* LanguageModel
  const turn = yield* lm
    .turn({
      history: [Items.userText("Give me a recipe for one-pan lemon chicken.")],
      model: "gpt-5.4-mini",
      structured: recipeFormat,
    })

  const recipe: Recipe = yield* Turn.toStructured(turn, recipeFormat)
  return recipe
})
```

`lm.turn(request)` returns `Effect<Turn>` — runs the streamed call to
completion and returns the assembled `Turn`. `Turn.toStructured(turn,
format)` extracts and validates the assistant's text against the
schema.

## Failure modes

`Turn.toStructured` returns one of three typed failures:

- `RefusalRejected` — the assistant emitted a refusal block.
- `JsonParseError` — assembled text wasn't valid JSON.
- `StructuredDecodeError` — JSON didn't match the schema.

```ts
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"

program.pipe(
  Effect.catchTag("RefusalRejected", () =>
    Effect.succeed({ kind: "refused" } as const),
  ),
  Effect.catchTags({
    JsonParseError: (e) => Effect.logError("bad JSON", e),
    StructuredDecodeError: (e) => Effect.logError("schema fail", e),
  }),
)
```

## Multi-object output

All three providers reject a top-level array schema (the wire format
requires `type: object`). Wrap arrays:

```ts
const RecipeList = Schema.Struct({ recipes: Schema.Array(Recipe) })
```

For *streaming* multi-object output (one object decoded as soon as its
JSON is complete), reach for `effect-uai-streaming-structured-output`
instead — that uses prompted JSONL with local-only validation.

## Anti-patterns

- **Don't `JSON.parse` the model's text yourself.** Use
  `Turn.toStructured` so refusals, parse errors, and schema errors
  get distinct typed failures.
- **Don't skip the local decoder** because "the provider promised the
  shape." Provider constraints can drift; the schema validation is
  what your application trusts.
- **Don't bypass the wrapper-object pattern** for arrays. The wire
  rejects `type: array` as the top-level shape.

## See also

- Recipe source: `recipes/structured-output/index.ts`
- For streaming objects one at a time: `effect-uai-streaming-structured-output`
- For tool-using conversations: `effect-uai-basic-usage`
