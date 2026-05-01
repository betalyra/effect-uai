---
title: Structured output
description: Constrain the model's output to a JSON Schema, then validate the assembled text against an Effect Schema.
---

# Recipe: Structured output

**Scenario.** You want the model to return data, not prose. Two patterns
in this recipe:

- **Single object** ([`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/structured-output/index.ts))
  - one `Recipe` per turn, server-enforced via JSON Schema, validated locally with `Turn.toStructured`.
- **Streaming JSONL** ([`streaming.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/structured-output/streaming.ts))
  - prompted JSONL, decoded one object at a time as the stream advances.

## What it shows

- `StructuredFormat.fromEffectSchema` adapts an Effect Schema for use as
  the wire-level JSON Schema and the local validator.
- `structured` on the request options constrains the model's output
  across all three providers via the generic `LanguageModel` tag.
- `Turn.toStructured` validates the assembled output, surfacing
  `RefusalRejected`, `JsonParseError`, or `StructuredDecodeError`.
- For streaming, `textDeltas → lines → decodeJsonLines`
  composes into a typed, per-object stream.

## Pattern 1 - single object

```ts
const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)

const program = Effect.gen(function* () {
  const turn = yield* runTurn([Items.userText("Give me a recipe for one-pan lemon chicken.")], {
    structured: recipeFormat,
  })
  const recipe: Recipe = yield* Turn.toStructured(turn, recipeFormat)
  yield* Effect.logInfo("recipe", { recipe })
})
```

Server-enforced shape plus local validation.

## Pattern 2 - streaming JSONL

The model is prompted to emit one JSON object per line, and each line is
validated as it arrives.

```ts
const program = streamTurn([Items.userText(prompt)]).pipe(
  Turn.textDeltas,
  Lines.lines,
  StructuredFormat.decodeJsonLines(recipeFormat),
  Stream.tap((recipe) => Effect.logInfo("recipe", { recipe })),
  Stream.runDrain,
)
```

This is *prompt-driven*, not server-enforced - JSONL has no native wire
format. Errors surface in the stream's failure channel, distinguished by
tag, so the caller can pick fail-fast (`Stream.runDrain`), skip-bad
(`Stream.catchTag` → `Stream.empty`), or log-and-continue.

For server-enforced multi-item output, wrap the array in an object:
`Schema.Struct({ recipes: Schema.Array(Recipe) })`. All three providers
require the top-level schema to be `type: object`, so a bare
`Schema.Array(Recipe)` is rejected.

## Run it

```sh
op run --env-file=./.env.dev -- pnpm tsx recipes/structured-output/index.ts --provider=responses
op run --env-file=./.env.dev -- pnpm tsx recipes/structured-output/index.ts --provider=anthropic
op run --env-file=./.env.dev -- pnpm tsx recipes/structured-output/index.ts --provider=gemini
```

```sh
op run --env-file=./.env.dev -- pnpm tsx recipes/structured-output/streaming.ts --provider=responses
```

Requires the matching API key in the environment: `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`.
