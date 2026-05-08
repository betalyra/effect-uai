---
name: effect-uai-streaming-structured-output
description: Use when the user wants typed JSON objects to appear one-by-one as the model writes them — e.g. live "search results", recipe streamer, transcoded chunks. Prompt for JSONL, frame the text stream into lines, decode each line with the schema. Errors are typed per stage.
license: MIT
---

# effect-uai streaming-structured-output

Typed JSON objects appear one-by-one as the model writes them. The
model is asked to emit JSONL (one JSON object per line, no prose);
each line is locally validated against the schema as it arrives.
Downstream consumers see a typed `Stream<Recipe>`, not raw text.

Reach for this when the user says any of:

- "Stream typed objects from the model as they arrive"
- "Show search results / recipes / events one at a time"
- "Decode JSONL streamed by the model"

## The pipeline

```ts
import { Effect, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import * as Lines from "@effect-uai/core/Lines"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"

const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)

const prompt = [
  "Give me 3 short cooking recipes as JSONL: one JSON object per line, no prose, no code fences.",
  `Example: {"title":"Lemon Chicken","ingredients":["chicken","lemon"],"prepMinutes":10}`,
].join("\n")

const program = streamTurn({
  history: [Items.userText(prompt)],
  model: "gpt-5.4-mini",
}).pipe(
  Turn.textDeltas, // TurnEvent stream -> text fragments
  Lines.lines, // text fragments -> newline-delimited lines
  StructuredFormat.decodeJsonLines(recipeFormat), // lines -> typed, validated objects
  Stream.tap((recipe) => Effect.logInfo("recipe", { recipe })),
  Stream.runDrain,
)
```

`textDeltas → lines → decodeJsonLines` composes left-to-right. Each
stage is independently testable; the per-stage error channel makes
recovery surgical.

## Failure policy is a choice

Decode failures land as typed errors in the failure channel
(`JsonParseError`, `StructuredDecodeError`). The caller picks how to
handle them:

```ts
// Fail-fast: any decode error stops the stream.
Stream.runDrain

// Skip bad lines.
Stream.catchTag("JsonParseError", () => Stream.empty)
Stream.catchTag("StructuredDecodeError", () => Stream.empty)

// Log-and-continue: turn errors into events the consumer handles.
Stream.catchTags({
  JsonParseError: (e) => Stream.succeed({ kind: "skip", reason: e.message }),
  StructuredDecodeError: (e) => Stream.succeed({ kind: "skip", reason: e.message }),
})
```

## When to NOT use this

- If you need server-enforced shape (single object, model must return
  _exactly_ this schema), use `effect-uai-structured-output` and
  buffer the whole turn. JSONL is prompt-driven, not wire-enforced.
- If you want the assistant's natural-language reply, not data, just
  consume `Turn.textDeltas` directly.

## Caveats

- **Models sometimes pretty-print** (newlines inside objects) or wrap
  output in code fences. The recipe uses an explicit example in the
  prompt to anchor the format. Be ready to skip occasional malformed
  lines.
- **No top-level array constraint** is needed because validation is
  local — the provider just sees a text completion request.

## See also

- Recipe source: `recipes/streaming-structured-output/index.ts`
- For one validated object: `effect-uai-structured-output`
- For wire-formatting a TurnEvent stream as JSONL: `effect-uai-modify-output-stream`
