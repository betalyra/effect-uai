/**
 * Streaming objects via prompted JSONL. The model is asked to emit one
 * JSON object per line; each line is validated against the schema as it
 * arrives. This is *not* server-enforced — there's no wire format that
 * makes JSONL native. Compose three primitives:
 *
 *   textDeltas         (TurnEvent stream → text fragments)
 *   lines              (text fragments → newline-delimited lines)
 *   decodeJsonLines    (lines → typed, validated objects)
 *
 * Each operator's failures are surfaced in the stream channel with a
 * distinct tag (`JsonParseError`, `StructuredDecodeError`), so the
 * caller picks the policy: fail-fast, skip-bad, log-and-continue.
 *
 * Switch providers via `--model provider:model`:
 *
 *   pnpm tsx recipes/streaming-structured-output/run.ts
 *   pnpm tsx recipes/streaming-structured-output/run.ts --model anthropic:claude-sonnet-4-6
 *   pnpm tsx recipes/streaming-structured-output/run.ts --model google:gemini-2.5-flash
 *
 * Caveat: prompt-driven JSONL is fragile. Models sometimes pretty-print
 * (newlines inside objects) or wrap output in code fences. This recipe
 * uses an explicit example in the prompt to anchor the format. For
 * server-enforced shape, use the single-object pattern in
 * `recipes/structured-output/`.
 */
import { Effect, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import * as Lines from "@effect-uai/core/Lines"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})
type Recipe = typeof Recipe.Type

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const prompt = [
  "Give me 3 short cooking recipes as JSONL: one JSON object per line, no prose, no code fences.",
  `Example: {"title":"Lemon Chicken","ingredients":["chicken","lemon"],"prepMinutes":10}`,
].join("\n")

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export const streamRecipes = (model: string) =>
  streamTurn({ history: [Items.userText(prompt)], model }).pipe(
    Turn.textDeltas,
    Lines.lines,
    StructuredFormat.decodeJsonLines(recipeFormat),
    Stream.tap((recipe: Recipe) => Effect.logInfo("recipe (streamed)", { recipe })),
    Stream.runDrain,
  )
