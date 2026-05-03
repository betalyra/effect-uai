---
title: Structured output
description: Constrain the model's output to a JSON Schema, then validate the assembled text against an Effect Schema.
---

**Scenario.** You want the model to return data, not prose. Define a
schema, hand it to the provider as a wire-level constraint, and
validate the assembled output locally before using it.

## What it shows

- `StructuredFormat.fromEffectSchema` adapts an Effect Schema for use
  as both the wire-level JSON Schema (sent to the provider) and the
  local validator (run after the turn lands).
- The `structured` option on the request constrains the model's
  output across all three providers via the generic `LanguageModel`
  tag.
- `Turn.toStructured` validates the assembled output, surfacing
  `RefusalRejected`, `JsonParseError`, or `StructuredDecodeError` as
  typed failures.

## Single object

```ts
const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)

const program = Effect.gen(function* () {
  const turn = yield* runTurn({
    history: [Items.userText("Give me a recipe for one-pan lemon chicken.")],
    model: "gpt-5.4-mini",
    structured: recipeFormat,
  })
  const recipe: Recipe = yield* Turn.toStructured(turn, recipeFormat)
  yield* Effect.logInfo("recipe", { recipe })
})
```

Server-enforced shape plus local validation. The model can't return
anything that doesn't match the schema; if it tries (or refuses), the
local validator surfaces a typed error.

## Multi-object output

For multiple items in a single response, wrap the array in an object:

```ts
const RecipeList = Schema.Struct({ recipes: Schema.Array(Recipe) })
```

All three providers require the top-level schema to be `type: object`,
so a bare `Schema.Array(Recipe)` is rejected at the wire.

For *streaming* multi-object output (one object decoded as soon as its
JSON is complete), see the
[Streaming structured output](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-structured-output)
recipe.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/structured-output/index.ts --provider=responses
ANTHROPIC_API_KEY=... pnpm tsx recipes/structured-output/index.ts --provider=anthropic
GOOGLE_API_KEY=...    pnpm tsx recipes/structured-output/index.ts --provider=gemini
```

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/structured-output/index.ts).
