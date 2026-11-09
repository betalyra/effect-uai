import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Function, Match, Schema, Stream } from "effect"
import type { ToolCall } from "../domain/Items.js"

export class ToolError extends Schema.TaggedError<ToolError>("@betalyra/effect-uai/ToolError")(
  "ToolError",
  {
    call_id: Schema.String,
    tool: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * One Standard Schema validation issue, carried on `ToolValidationError`.
 * `path` elements stay `unknown`: Standard Schema segments may be symbols or `{ key }`.
 */
const ToolValidationIssue = Schema.Struct({
  message: Schema.String,
  path: Schema.optional(Schema.Array(Schema.Unknown)),
})

/** A call's `arguments` failed the tool's `inputSchema` (from `decodeArgs`). */
export class ToolValidationError extends Schema.TaggedError<ToolValidationError>(
  "@betalyra/effect-uai/ToolValidationError",
)("ToolValidationError", {
  call_id: Schema.String,
  tool: Schema.String,
  issues: Schema.Array(ToolValidationIssue),
}) {}

/**
 * A ready-made model-visible error for one-off messages. It reaches the model
 * only when listed in the tool's `failureSchema` (or via `Toolkit.describeFailures`).
 */
export class ToolFailed extends Schema.TaggedError<ToolFailed>("@betalyra/effect-uai/ToolFailed")(
  "ToolFailed",
  { message: Schema.String },
) {}

/** `yield* Tool.fail("page not found")` inside a `run`. */
export const fail = (message: string): Effect.Effect<never, ToolFailed> =>
  Effect.fail(new ToolFailed({ message }))

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/**
 * Standard Schema with JSON Schema conversion (Zod 4+, Valibot, ArkType, or an
 * Effect Schema via `fromEffectSchema`). Validates the model's arguments and
 * renders the provider descriptor.
 */
export type ToolInputSchema<Input = unknown> = StandardSchemaV1<unknown, Input> &
  StandardJSONSchemaV1<unknown, Input>

/** What `inputSchema` accepts: an Effect Schema directly, or a `ToolInputSchema`. */
export type InputSchema<Input> = Schema.Codec<Input, any, never, any> | ToolInputSchema<Input>

/** Adds the Standard Schema and Standard JSON Schema interfaces to an Effect Schema. */
export const fromEffectSchema = <S extends Schema.Codec<any, any, never, any>>(
  schema: S,
): S & ToolInputSchema<S["Type"]> =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))

/**
 * Types a schema that implements both Standard Schema and Standard JSON Schema
 * (Zod 4.2+, Valibot 1.2+, ArkType 2.1.28+). A schema missing either half is a
 * compile error here rather than a runtime surprise.
 */
export const fromStandardSchema = <S extends StandardSchemaV1 & StandardJSONSchemaV1>(
  schema: S,
): S & ToolInputSchema<StandardSchemaV1.InferOutput<S>> =>
  schema as S & ToolInputSchema<StandardSchemaV1.InferOutput<S>>

/**
 * Input for a tool without arguments: renders `{ type: "object", properties: {} }`
 * (an empty `Schema.Struct` renders an `anyOf` that strict providers reject).
 */
export const noInput: ToolInputSchema<Record<string, never>> = {
  "~standard": {
    version: 1,
    vendor: "effect-uai",
    validate: () => ({ value: {} }),
    jsonSchema: {
      input: () => ({ type: "object", properties: {} }),
      output: () => ({ type: "object", properties: {} }),
    },
  },
}

const resolveInputSchema = <Input>(schema: InputSchema<Input>): ToolInputSchema<Input> =>
  Schema.isSchema(schema) ? fromEffectSchema(schema) : schema

// ---------------------------------------------------------------------------
// Tool kinds
// ---------------------------------------------------------------------------

/** One result (`Effect`) or partial results whose last element is the result (`Stream`). */
export type Run<Input, Output, E, R> = (
  input: Input,
) => Effect.Effect<Output, E, R> | Stream.Stream<Output, E, R>

/** Whether `run` returned a `Stream` (values as partials) rather than an `Effect` (one value). */
export const isStreamed = <A, E, R>(
  out: Effect.Effect<A, E, R> | Stream.Stream<A, E, R>,
): out is Stream.Stream<A, E, R> => Stream.isStream(out)

/** An `Effect` is a one-element stream. */
export const toStream = <A, E, R>(
  out: Effect.Effect<A, E, R> | Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> => (Effect.isEffect(out) ? Stream.fromEffect(out) : out)

/**
 * A model-visible tool. With `run`, `Toolkit.run` executes it: errors matching
 * `failureSchema` reach the model, any other error fails the stream. Without
 * `run`, the app handles its calls: a signal to the loop (`escalate`), or a call
 * answered elsewhere (`ask_user`, typed by `outputSchema`).
 */
export type Tool<Name extends string, Input, Output, Failure = never, E = never, R = never> = {
  readonly _tag: "LocalTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  /** Checks every value and encodes it for history and the UI. A rejected value is `OutputInvalid`. */
  readonly outputSchema?: Schema.Codec<Output, any>
  /**
   * Every error a call may end with that the model sees: errors `run` raises and
   * errors the app closes calls with (`Approval.Denied`, see `Toolkit.close`).
   */
  readonly failureSchema?: Schema.Codec<Failure, any>
  readonly run?: Run<Input, Output, E, R>
  /** Render with the provider's strict-mode flag. Default: true. */
  readonly strict?: boolean
}

/** A tool with `run`, the only kind `Toolkit.run` executes. */
export type Runnable<T extends AnyLocalTool = AnyLocalTool> = T & {
  readonly run: NonNullable<T["run"]>
}

export const hasRun = <T extends AnyLocalTool>(tool: T): tool is Runnable<T> =>
  tool.run !== undefined

/**
 * A provider-hosted tool (native web search, code execution, grounding), executed
 * by the provider. `provider` / `config` drive the adapter's rendering.
 */
export type ProviderTool<Name extends string, Input, Provider extends string, Config> = {
  readonly _tag: "ProviderTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly provider: Provider
  readonly config: Config
  readonly strict?: boolean
}

export type AnyLocalTool<E = any, R = any> = Tool<string, any, any, any, E, R>

export type AnyTool<E = any, R = any> = AnyLocalTool<E, R> | ProviderTool<string, any, string, any>

/** Any tool kind with a decodable input schema. */
export type DecodableTool<Input> = {
  readonly name: string
  readonly inputSchema: ToolInputSchema<Input>
}

export type ToolOutput<T> = T extends Tool<string, any, infer O, any, any, any> ? O : never
export type ToolFailure<T> = T extends Tool<string, any, any, infer F, any, any> ? F : never
export type ToolE<T> = T extends Tool<string, any, any, any, infer E, any> ? E : never
export type ToolR<T> = T extends Tool<string, any, any, any, any, infer R> ? R : never

/** The errors a tool did not declare: these fail `Toolkit.run`'s stream. */
export type ToolUnhandled<T> =
  T extends Tool<string, any, any, infer F, infer E, any> ? Exclude<E, F> : never

type Spec<Name extends string, Input, Failure, FailureEncoded> = {
  readonly name: Name
  readonly description: string
  readonly inputSchema: InputSchema<Input>
  readonly failureSchema?: Schema.Codec<Failure, FailureEncoded>
  readonly strict?: boolean
}

/**
 * Without `run`, the app handles the tool's calls: a signal to the loop
 * (no `outputSchema`), or a call answered elsewhere (typed by `outputSchema`).
 */
export function make<
  const Name extends string,
  Input,
  Output = never,
  Encoded extends Schema.Json = never,
  Failure = never,
  FailureEncoded extends Schema.Json = never,
>(
  spec: Spec<Name, Input, Failure, FailureEncoded> & {
    readonly outputSchema?: Schema.Codec<Output, Encoded>
    readonly run?: undefined
  },
): Tool<Name, Input, Output, Failure>
/**
 * With `run`, `outputSchema` says what it returns and its encoded side must be
 * JSON. `Content.Value` is the explicit "anything": text, JSON or media.
 */
export function make<
  const Name extends string,
  Input,
  Output,
  Encoded extends Schema.Json,
  Failure = never,
  FailureEncoded extends Schema.Json = never,
  E = never,
  R = never,
>(
  spec: Spec<Name, Input, Failure, FailureEncoded> & {
    readonly outputSchema: Schema.Codec<Output, Encoded>
    readonly run: Run<Input, Output, E, R>
  },
): Tool<Name, Input, Output, Failure, E, R>
export function make(
  spec: Spec<string, unknown, unknown, unknown> & {
    readonly outputSchema?: Schema.Codec<unknown, any> | undefined
    readonly run?: Run<unknown, unknown, unknown, unknown> | undefined
  },
): AnyLocalTool {
  const { outputSchema, inputSchema, run, ...rest } = spec
  return {
    _tag: "LocalTool",
    ...rest,
    inputSchema: resolveInputSchema(inputSchema),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(run === undefined ? {} : { run }),
  }
}

/** A provider-hosted tool. */
export const provider = <const Name extends string, Input, Provider extends string, Config>(
  spec: Omit<ProviderTool<Name, Input, Provider, Config>, "_tag" | "inputSchema"> & {
    readonly inputSchema: InputSchema<Input>
  },
): ProviderTool<Name, Input, Provider, Config> => ({
  _tag: "ProviderTool",
  ...spec,
  inputSchema: resolveInputSchema(spec.inputSchema),
})

/** A copy of a tool under a new `name`, e.g. to resolve a clash before `Toolkit.compose`. */
export const withName = <N extends string, T extends AnyTool>(
  tool: T,
  name: N,
): Omit<T, "name"> & { readonly name: N } => ({ ...tool, name })

/**
 * Replace a tool's `run`, keeping everything else (name, description, schemas),
 * e.g. to mock it. The new `run` returns the same output type.
 */
export const withRun = <Name extends string, Input, Output, Failure, E, R, E2 = never, R2 = never>(
  tool: Tool<Name, Input, Output, Failure, E, R>,
  run: Run<Input, Output, E2, R2>,
): Runnable<Tool<Name, Input, Output, Failure, E2, R2>> => ({ ...tool, run })

/**
 * Add errors a call of this tool may end with, e.g. the app's `Approval.Denied`
 * for a tool that needs approval. Its `run` need not raise them; the app closes
 * calls with them (`Toolkit.close`).
 */
export const withFailures: {
  <F2, F2Encoded extends Schema.Json>(
    failures: Schema.Codec<F2, F2Encoded>,
  ): <Name extends string, Input, Output, Failure, E, R>(
    tool: Tool<Name, Input, Output, Failure, E, R>,
  ) => Tool<Name, Input, Output, Failure | F2, E, R>
  <Name extends string, Input, Output, Failure, E, R, F2, F2Encoded extends Schema.Json>(
    tool: Tool<Name, Input, Output, Failure, E, R>,
    failures: Schema.Codec<F2, F2Encoded>,
  ): Tool<Name, Input, Output, Failure | F2, E, R>
} = Function.dual(
  2,
  <Name extends string, Input, Output, Failure, E, R, F2>(
    tool: Tool<Name, Input, Output, Failure, E, R>,
    failures: Schema.Codec<F2, any>,
  ): Tool<Name, Input, Output, Failure | F2, E, R> => ({
    ...tool,
    failureSchema:
      tool.failureSchema === undefined ? failures : Schema.Union([tool.failureSchema, failures]),
  }),
)

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/** Provider-agnostic descriptor; each provider maps `inputSchema` to its own field. */
export type ToolDescriptor = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly strict?: boolean
}

export const isProviderTool = (tool: AnyTool): tool is ProviderTool<string, any, string, any> =>
  tool._tag === "ProviderTool"

/** The provider-hosted tools in a toolkit, for an adapter to render natively. */
export const providerToolsOf = (
  toolkit?: Readonly<Record<string, AnyTool>>,
): ReadonlyArray<ProviderTool<string, any, string, any>> =>
  toolkit === undefined ? [] : Object.values(toolkit).filter(isProviderTool)

/** Function descriptors for every tool except provider-hosted ones. */
export const toDescriptors = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolDescriptor> =>
  tools
    .filter((tool) => !isProviderTool(tool))
    .map((tool) => {
      const inputSchema = tool.inputSchema["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      })
      const strict = "strict" in tool ? tool.strict : undefined
      return strict !== undefined
        ? { name: tool.name, description: tool.description, inputSchema, strict }
        : { name: tool.name, description: tool.description, inputSchema }
    })

/** `toDescriptors` over a toolkit record; an absent toolkit has none. */
export const descriptorsOf = (
  toolkit?: Readonly<Record<string, AnyTool>>,
): ReadonlyArray<ToolDescriptor> =>
  toolkit === undefined ? [] : toDescriptors(Object.values(toolkit))

// ---------------------------------------------------------------------------
// Decoding arguments
// ---------------------------------------------------------------------------

export type DecodeResult<Input> =
  | { readonly _tag: "ok"; readonly input: Input }
  | { readonly _tag: "parseError" }
  | { readonly _tag: "invalid"; readonly issues: ReadonlyArray<StandardSchemaV1.Issue> }

const VALIDATION_THREW: ReadonlyArray<StandardSchemaV1.Issue> = [
  { message: "input schema validation threw" },
]

/**
 * Parse and validate a call's `arguments`, as data. Empty arguments read as `{}`
 * (some models send `""` for tools without arguments). Never fails.
 */
export const decodeCallInput = <Input>(
  tool: DecodableTool<Input>,
  call: ToolCall,
): Effect.Effect<DecodeResult<Input>> => {
  const raw = call.arguments.trim() === "" ? "{}" : call.arguments
  return Effect.try({
    // @effect-diagnostics-next-linepreferSchemaOverJson:off
    try: () => JSON.parse(raw) as unknown,
    catch: (): DecodeResult<Input> => ({ _tag: "parseError" }),
  }).pipe(
    Effect.flatMap((parsed) =>
      Effect.tryPromise({
        try: () => Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
        catch: (): DecodeResult<Input> => ({ _tag: "invalid", issues: VALIDATION_THREW }),
      }).pipe(
        Effect.map((result): DecodeResult<Input> =>
          result.issues !== undefined
            ? { _tag: "invalid", issues: result.issues }
            : { _tag: "ok", input: result.value },
        ),
      ),
    ),
    Effect.catch((captured: DecodeResult<Input>) => Effect.succeed(captured)),
  )
}

/**
 * A call's typed input, e.g. for a tool without `run` the loop handles itself.
 * Bad JSON fails with `ToolError`, a schema violation with `ToolValidationError`.
 */
export const decodeArgs = <Input>(
  tool: DecodableTool<Input>,
  call: ToolCall,
): Effect.Effect<Input, ToolError | ToolValidationError> =>
  decodeCallInput(tool, call).pipe(
    Effect.flatMap(
      Match.type<DecodeResult<Input>>().pipe(
        Match.tag("ok", ({ input }) => Effect.succeed(input)),
        Match.tag("parseError", () =>
          Effect.fail(
            new ToolError({
              call_id: call.call_id,
              tool: tool.name,
              message: "Failed to parse JSON arguments",
            }),
          ),
        ),
        Match.tag("invalid", ({ issues }) =>
          Effect.fail(new ToolValidationError({ call_id: call.call_id, tool: tool.name, issues })),
        ),
        Match.exhaustive,
      ),
    ),
  )
