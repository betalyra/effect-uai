---
title: Structured output
description: Use one schema as both the provider contract and the local validator.
source: recipes/structured-output
---

Structured output is the same turn primitive with a stronger boundary
contract.

You still run one model turn. The difference is that the schema crosses the
boundary twice: first as JSON Schema sent to the provider, then as an Effect
Schema validator run locally after the turn lands. The provider is asked to
produce the shape; your application still checks before trusting it.

**Scenario.** Ask for a recipe and receive typed data, not prose.

## The Contract

```ts
const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})
type Recipe = typeof Recipe.Type

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)
```

`StructuredFormat.fromEffectSchema` adapts the Effect Schema into the two
things this boundary needs:

- a provider-facing JSON Schema constraint;
- a local decoder for the assembled model output.

## One Turn, Typed Result

```ts
const program = Effect.gen(function* () {
  const turn = yield* runTurn({
    history: [Items.userText("Give me a recipe for one-pan lemon chicken.")],
    model: "gpt-5.4-mini",
    // The provider sees JSON Schema; your app keeps the Effect Schema decoder.
    structured: recipeFormat,
  })

  const recipe: Recipe = yield* Turn.toStructured(turn, recipeFormat)
  yield* Effect.logInfo("recipe", { recipe })
})
```

The request is still just a normal `LanguageModel` turn. The `structured`
option constrains generation across OpenAI, Anthropic, and Gemini providers.
`Turn.toStructured` then validates the final assembled text and returns typed
data or a typed failure.

## Failure Is Data Too

Structured output can fail in distinct ways:

- **`RefusalRejected`** — the assistant refused instead of producing output.
- **`JsonParseError`** — the assembled text was not valid JSON.
- **`StructuredDecodeError`** — the JSON did not match the schema.

Those failures stay in the Effect error channel, so callers decide whether to
retry, fall back, ask a repair model, or surface the problem.

## Multi-object output

For multiple items in a single response, wrap the array in an object:

```ts
const RecipeList = Schema.Struct({ recipes: Schema.Array(Recipe) })
```

All three providers require the top-level schema to be `type: object`,
so a bare `Schema.Array(Recipe)` is rejected at the wire.

For _streaming_ multi-object output (one object decoded as soon as its
JSON is complete), see the
[Streaming structured output](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-structured-output)
recipe.

## Where you'll reach for this

Any time you want a value back, not prose to parse:

- **Extraction and classification.** Pull a contact, an invoice, or a
  support-ticket category out of free text and hand the rest of your
  program a typed record it can trust.
- **A typed decision inside a loop.** When a turn has to pick a branch,
  decode the choice and `switch` on it instead of string-matching the
  model's words.
- **Trying another provider.** `structured` is honored by OpenAI,
  Anthropic, and Gemini, so switching is a layer change, not a rewrite.

When the objects should arrive one at a time as the model writes them (a
live results list, a long batch you don't want to wait out), reach for
[Streaming structured output](/recipes/streaming-structured-output/).

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/structured-output/index.ts --provider=responses
ANTHROPIC_API_KEY=... pnpm tsx recipes/structured-output/index.ts --provider=anthropic
GOOGLE_API_KEY=...    pnpm tsx recipes/structured-output/index.ts --provider=gemini
```

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/structured-output/index.ts).
