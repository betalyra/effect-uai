/**
 * Tool values to history parts, and back. One rule, top level only:
 *   string → text · media → its part · array with media → one part per element ·
 *   anything else → one JSON value.
 * Every value goes through a schema (the tool's `outputSchema`, else `Content.Value`):
 * the decoded side decides the shape and supplies media, the encoded side the JSON.
 */
import { Array as Arr, Effect, Match, Predicate, Schema } from "effect"
import * as Items from "../domain/Items.js"
import type { ToolCall, ToolCallOutput, ToolOutputContent } from "../domain/Items.js"
import * as Content from "./Content.js"

type CallId = Pick<ToolCall, "call_id">

const toPart = Match.type<Content.Media>().pipe(
  Match.tagsExhaustive({
    Image: (m) => Items.image(m.source),
    File: (m) => Items.file(m.source, m.filename),
  }),
)

const fromPart = Match.type<ToolOutputContent>().pipe(
  Match.discriminatorsExhaustive("type")({
    input_text: (p) => p.text,
    input_json: (p) => p.value,
    input_image: (p) => Content.image(p.source),
    input_file: (p) => Content.file(p.source, p.filename),
  }),
)

const isMixed = (u: unknown): u is ReadonlyArray<unknown> =>
  Array.isArray(u) && u.some(Content.isMedia)

const zipMixed = (
  decoded: ReadonlyArray<unknown>,
  encoded: Schema.Json,
): ReadonlyArray<ToolOutputContent> =>
  Array.isArray(encoded) && encoded.length === decoded.length
    ? Arr.zipWith(decoded, encoded, (d, e) =>
        Match.value(d).pipe(
          Match.when(Content.isMedia, toPart),
          Match.orElse(() => (Predicate.isString(e) ? Items.text(e) : Items.json(e))),
        ),
      )
    : [Items.json(encoded)] // the schema reshaped the array: keep its JSON whole

/** `decoded` decides the shape and supplies media; `encoded` supplies the JSON. */
export const parts = (decoded: unknown, encoded: Schema.Json): ReadonlyArray<ToolOutputContent> =>
  Match.value(decoded).pipe(
    Match.when(Predicate.isString, (text) => [Items.text(text)]),
    Match.when(Content.isMedia, (media) => [toPart(media)]),
    Match.when(isMixed, (values) => zipMixed(values, encoded)),
    Match.orElse(() => [Items.json(encoded)]),
  )

/** A value, encoded by `schema`, as the call's output. */
export const success = <A>(
  call: CallId,
  schema: Schema.Codec<A, Schema.Json>,
  value: A,
): Effect.Effect<ToolCallOutput, Schema.SchemaError> =>
  Effect.map(Schema.encodeEffect(schema)(value), (encoded) => ({
    type: "function_call_output",
    call_id: call.call_id,
    output: parts(value, encoded),
  }))

/** An error, encoded by `schema`, as the call's output, flagged `isError`. */
export const failure = <E>(
  call: CallId,
  schema: Schema.Codec<E, Schema.Json>,
  error: E,
): Effect.Effect<ToolCallOutput, Schema.SchemaError> =>
  Effect.map(Schema.encodeEffect(schema)(error), (encoded) => ({
    type: "function_call_output",
    call_id: call.call_id,
    output: [Items.json(encoded)],
    isError: true,
  }))

/** Any `Content.Value` as the call's output, for calls the app closes itself. */
export const make = (call: CallId, value: Content.Value) => success(call, Content.Value, value)

// A single part reads back as itself, so a one-element array of media comes back unwrapped.
const single = <A>(values: ReadonlyArray<A>): A | ReadonlyArray<A> =>
  Arr.isReadonlyArrayNonEmpty(values) && values.length === 1 ? Arr.headNonEmpty(values) : values

/** Parts back to a `Content.Value`, read from the parts' own types. */
export const value = (output: ReadonlyArray<ToolOutputContent>): Content.Value =>
  single(output.map(fromPart))

/** Parts back to the encoded form an `outputSchema` decodes (media re-encoded). */
export const encoded = (
  output: ReadonlyArray<ToolOutputContent>,
): Effect.Effect<unknown, Schema.SchemaError> =>
  Effect.forEach(output.map(fromPart), (v) =>
    Content.isMedia(v) ? Schema.encodeEffect(Content.Media)(v) : Effect.succeed(v),
  ).pipe(Effect.map(single))

// --- core's own failures -------------------------------------------------------

/** The model's arguments are not JSON or fail `inputSchema`. */
export class InputInvalid extends Schema.TaggedError<InputInvalid>(
  "@betalyra/effect-uai/InputInvalid",
)("InputInvalid", { message: Schema.String }) {}

/** `run` returned a value its `outputSchema` rejects: a bug in the tool. */
export class OutputInvalid extends Schema.TaggedError<OutputInvalid>(
  "@betalyra/effect-uai/OutputInvalid",
)("OutputInvalid", { message: Schema.String }) {}

/** No local tool by that name (hallucinated, removed, or a declared or provider tool). */
export class UnknownTool extends Schema.TaggedError<UnknownTool>(
  "@betalyra/effect-uai/UnknownTool",
)("UnknownTool", { message: Schema.String }) {}

/** The call was left unanswered and closed before the next model call. */
export class Cancelled extends Schema.TaggedError<Cancelled>("@betalyra/effect-uai/Cancelled")(
  "Cancelled",
  { message: Schema.String },
) {}

/** What `Toolkit.run` produces itself. */
export type RunError = InputInvalid | OutputInvalid | UnknownTool
export const RunError = Schema.Union([InputInvalid, OutputInvalid, UnknownTool])

/** Every error core writes into history; what history and the UI always decode. */
export type CoreError = RunError | Cancelled
export const CoreError = Schema.Union([InputInvalid, OutputInvalid, UnknownTool, Cancelled])
