import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Data, Effect, Match, Schema, Stream, pipe } from "effect"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cross-validator schema constraint for structured outputs. Any schema
 * implementing both Standard Schema (runtime validation) and Standard
 * JSON Schema (wire encoding) works directly: Zod 4+, Valibot, ArkType,
 * and Effect Schema after `fromEffectSchema`.
 */
export type StructuredSchema<Output = unknown> = StandardSchemaV1<unknown, Output> &
  StandardJSONSchemaV1<unknown, Output>

/**
 * A schema-bound output the user wants the model to produce. Pairs the
 * cross-validator schema with metadata providers need (name, description,
 * strict-mode flag).
 */
export interface StructuredFormat<A> {
  readonly name: string
  readonly description?: string
  readonly schema: StructuredSchema<A>
  /**
   * Provider strict-mode flag. OpenAI, Anthropic, and Mistral honour it
   * (constrained decoding); other providers ignore.
   */
  readonly strict?: boolean
}

/** A single path-scoped validation problem. Library-agnostic shape. */
export interface DecodeIssue {
  readonly path: ReadonlyArray<string | number>
  readonly message: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Schema validation failed. `raw` is the original text (or stringified
 * value) that failed; `issues` is a flat list of per-field problems.
 */
export class StructuredDecodeError extends Data.TaggedError("StructuredDecodeError")<{
  readonly raw: string
  readonly issues: ReadonlyArray<DecodeIssue>
}> {}

/**
 * `JSON.parse` threw on a string that was supposed to be JSON. Distinct
 * from `StructuredDecodeError`: the bytes weren't even JSON.
 */
export class JsonParseError extends Data.TaggedError("StructuredJsonParseError")<{
  readonly raw: string
  readonly cause: unknown
}> {}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Wrap an Effect `Schema` as a `StructuredFormat`. Effect Schema doesn't
 * natively implement Standard Schema; this helper installs the
 * `~standard` and JSON Schema interfaces.
 */
export const fromEffectSchema = <S extends Schema.Codec<any, any, never, any>>(
  schema: S,
  options?: {
    readonly name?: string
    readonly description?: string
    readonly strict?: boolean
  },
): StructuredFormat<S["Type"]> => ({
  name: options?.name ?? "output",
  schema: Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema)),
  ...(options?.description !== undefined && {
    description: options.description,
  }),
  ...(options?.strict !== undefined && { strict: options.strict }),
})

// ---------------------------------------------------------------------------
// Standard Schema → DecodeIssue
// ---------------------------------------------------------------------------

const propertyKeyToScalar = Match.type<PropertyKey>().pipe(
  Match.when(Match.string, (s) => s),
  Match.when(Match.number, (n) => n),
  Match.when(Match.symbol, (s) => s.toString()),
  Match.exhaustive,
)

const segmentToKey = Match.type<PropertyKey | StandardSchemaV1.PathSegment>().pipe(
  Match.when(Match.string, (s) => s),
  Match.when(Match.number, (n) => n),
  Match.when(Match.symbol, (s) => s.toString()),
  Match.orElse((segment) => propertyKeyToScalar(segment.key)),
)

const issueToDecode = (issue: StandardSchemaV1.Issue): DecodeIssue => ({
  path: (issue.path ?? []).map(segmentToKey),
  message: issue.message,
})

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Validate an `unknown` against the format's schema. Returns the typed
 * value or a `StructuredDecodeError`. Standard Schema's `validate` may
 * be async; this function handles both sync and async results.
 */
export const decode =
  <A>(format: StructuredFormat<A>) =>
  (raw: unknown): Effect.Effect<A, StructuredDecodeError> =>
    pipe(
      Effect.promise(async () => format.schema["~standard"].validate(raw)),
      Effect.flatMap((result) =>
        result.issues === undefined
          ? Effect.succeed(result.value)
          : Effect.fail(
              new StructuredDecodeError({
                raw: typeof raw === "string" ? raw : JSON.stringify(raw),
                issues: result.issues.map(issueToDecode),
              }),
            ),
      ),
    )

/**
 * Parse a JSON string then validate against the format's schema. Two
 * failure modes: `JsonParseError` (bytes weren't JSON) and
 * `StructuredDecodeError` (JSON didn't match the schema).
 */
export const parseJson =
  <A>(format: StructuredFormat<A>) =>
  (raw: string): Effect.Effect<A, JsonParseError | StructuredDecodeError> =>
    pipe(
      Effect.try({
        try: () => JSON.parse(raw),
        catch: (cause) => new JsonParseError({ raw, cause }),
      }),
      Effect.flatMap(decode(format)),
    )

/**
 * Stream operator: each input string is JSON-parsed and validated.
 * Failures surface in the stream's failure channel, distinguished by tag.
 */
export const decodeJsonLines =
  <A>(format: StructuredFormat<A>) =>
  <E, R>(
    self: Stream.Stream<string, E, R>,
  ): Stream.Stream<A, E | JsonParseError | StructuredDecodeError, R> =>
    self.pipe(Stream.mapEffect(parseJson(format)))
