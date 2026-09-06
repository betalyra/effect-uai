/**
 * One schema, two jobs: the provider's structured-output contract and the
 * local validator. The server enforces the shape, and
 * `Turn.decodeStructured` is the safety net that turns a wire-level surprise
 * into a typed `StructuredDecodeError` instead of a bad object.
 */
import { Effect, Option, Result, Schema, Stream } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import type { JsonParseError, StructuredDecodeError } from "@effect-uai/core/StructuredFormat"
import * as Items from "@effect-uai/core/Items"
import { type LanguageModel, streamTurn } from "@effect-uai/core/LanguageModel"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"

export const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})
export type Recipe = typeof Recipe.Type

export const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)

export const DEFAULT_PROMPT = "Give me a recipe for one-pan lemon chicken."

/** Provider failures plus the three ways a schema-shaped answer can still be wrong. */
export type DecodeFailure =
  | AiError.AiError
  | JsonParseError
  | StructuredDecodeError
  | Turn.RefusalRejected

export const structuredRecipe = (
  model: string,
  prompt: string = DEFAULT_PROMPT,
): Effect.Effect<Recipe, DecodeFailure, LanguageModel> =>
  streamTurn({
    history: [Items.userText(prompt)],
    model,
    structured: recipeFormat,
  }).pipe(
    // Fold the event stream into the terminal `Turn`. `streamTurn` is the
    // primitive; collecting events into a `Turn` is recipe-level glue.
    Stream.filterMap((e) => (Turn.isTurnComplete(e) ? Result.succeed(e.turn) : Result.failVoid)),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(new AiError.IncompleteTurn({})),
      }),
    ),
    Effect.flatMap((turn) => Turn.decodeStructured(turn, recipeFormat)),
  )
