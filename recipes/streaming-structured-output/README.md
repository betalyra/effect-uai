---
title: Streaming structured output
description: Decode JSONL one object at a time as the model streams. Typed per-object Stream, errors in the failure channel.
---

**Scenario.** You want the model to emit a list of structured objects
and surface them to the user as they arrive — not all at once at the
end. Each object is validated against an Effect Schema as soon as its
JSON is complete; downstream consumers see a typed `Stream<Recipe>`,
not raw text.

This is *prompt-driven*, not server-enforced — JSONL has no native
wire format. The combinators stay the same across all three providers
because validation happens locally on the assembled text. Server-side
constraints are still possible by wrapping the list in an object (see
[Structured output](https://github.com/betalyra/effect-uai/blob/main/recipes/structured-output)),
at the cost of buffering the entire response.

## What it shows

- `Turn.textDeltas` extracts the assistant's text-delta channel from
  the raw provider stream.
- `Lines.lines` re-frames the byte stream into newline-terminated lines,
  handling chunks split mid-character.
- `StructuredFormat.decodeJsonLines(format)` parses each line as JSON
  and validates against the format's schema. Decode failures surface
  as typed errors in the `Stream`'s failure channel, distinguished by
  tag.
- The caller picks the failure policy: fail-fast (`Stream.runDrain`),
  skip-bad (`Stream.catchTag` → `Stream.empty`), or log-and-continue.

## Pipeline shape

```ts
const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)

const prompt = `
Emit five JSONL recipes - one valid JSON object per line, no surrounding
prose. Schema: { title, ingredients[], prepMinutes }.
`

const program = streamTurn({
  history: [Items.userText(prompt)],
  model: "gpt-5.4-mini",
}).pipe(
  Turn.textDeltas,
  Lines.lines,
  StructuredFormat.decodeJsonLines(recipeFormat),
  Stream.tap((recipe) => Effect.logInfo("recipe", { recipe })),
  Stream.runDrain,
)
```

`textDeltas → lines → decodeJsonLines` composes left-to-right. Each
stage is independently testable; the per-stage error channel makes
recovery surgical.

## Failure policy

```ts
// Fail-fast: any decode error stops the stream.
Stream.runDrain

// Skip bad lines: drop on JsonParseError or StructuredDecodeError.
Stream.catchTag("JsonParseError", () => Stream.empty)
Stream.catchTag("StructuredDecodeError", () => Stream.empty)

// Log-and-continue: turn errors into events the consumer handles.
Stream.catchTags({
  JsonParseError: (e) => Stream.succeed({ kind: "skip", reason: e.message }),
  StructuredDecodeError: (e) => Stream.succeed({ kind: "skip", reason: e.message }),
})
```

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/streaming-structured-output/index.ts --provider=responses
```

Requires the matching API key in the environment: `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-structured-output/index.ts).
