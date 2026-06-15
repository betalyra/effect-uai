import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Schema } from "effect"
import type { ToolCall, ToolCallOutput } from "../domain/Items.js"
import { toolCallOutput } from "../domain/Items.js"

export class ToolError extends Schema.TaggedErrorClass<ToolError>("@betalyra/effect-uai/ToolError")(
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
 * Mirrors `StandardSchemaV1.Issue`; `path` is left as `unknown` elements
 * because Standard Schema path segments may be symbols or `{ key }` objects.
 */
const ToolValidationIssue = Schema.Struct({
  message: Schema.String,
  path: Schema.optional(Schema.Array(Schema.Unknown)),
})

/**
 * The model's `arguments` for a call failed the tool's `inputSchema`. Distinct
 * from `ToolError` (malformed JSON, runtime crash) so callers can tell a
 * contract violation apart from a parse or execution failure, and so the
 * structured `issues` survive instead of being flattened into a message string.
 */
export class ToolValidationError extends Schema.TaggedErrorClass<ToolValidationError>(
  "@betalyra/effect-uai/ToolValidationError",
)("ToolValidationError", {
  call_id: Schema.String,
  tool: Schema.String,
  issues: Schema.Array(ToolValidationIssue),
}) {}

/**
 * Schemas accepted on `Tool.inputSchema`. Must implement both Standard
 * Schema validation and JSON Schema conversion (for rendering tool
 * descriptors to provider request bodies).
 *
 * Any Standard-Schema-compliant library that exposes both interfaces
 * works directly: Zod 4+, Valibot, ArkType, Effect Schema (after
 * `fromEffectSchema`), etc.
 */
export type ToolInputSchema<Input = unknown> = StandardSchemaV1<unknown, Input> &
  StandardJSONSchemaV1<unknown, Input>

/**
 * Convenience wrapper for Effect Schema users - adds both the
 * `validate` and `jsonSchema` extensions to a plain Effect Schema so it
 * can be used as a `Tool.inputSchema`.
 */
export const fromEffectSchema = <S extends Schema.Codec<any, any, never, any>>(
  schema: S,
): S & ToolInputSchema<S["Type"]> =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))

/**
 * Use any schema library that implements both Standard Schema (validation)
 * and Standard JSON Schema (JSON Schema generation) as a `Tool.inputSchema`.
 * Covers Zod 4.2+, Valibot 1.2+, and ArkType 2.1.28+ in one helper.
 *
 * Effect Schema doesn't implement Standard JSON Schema natively — use
 * `fromEffectSchema` for those.
 *
 * The intersection constraint catches missing interfaces at compile time:
 * a Zod v3 schema (no Standard JSON Schema) produces a precise type error
 * pointing at the missing interface rather than a runtime surprise. The
 * helper itself is a thin type-narrowing identity — schemas that satisfy
 * both standards already structurally satisfy `ToolInputSchema`; the
 * helper makes the input type inference explicit at the call site.
 */
export const fromStandardSchema = <S extends StandardSchemaV1 & StandardJSONSchemaV1>(
  schema: S,
): S & ToolInputSchema<StandardSchemaV1.InferOutput<S>> =>
  schema as S & ToolInputSchema<StandardSchemaV1.InferOutput<S>>

/**
 * Emit one intermediate `Event` from inside a tool's `run`. Backed by the
 * executor's per-call queue, so it returns an `Effect` (backpressure) and
 * composes with `Stream.runForEach(emit)`.
 */
export type Emit<Event> = (event: Event) => Effect.Effect<void>

/**
 * A tool the model can call. `run` is an `Effect` that computes the
 * model-facing `Output`; emitting progress is a side channel via `emit`. A
 * plain tool never calls `emit` (its `Event` is irrelevant); a streaming tool
 * emits intermediate `Event`s that flow to the consumer as
 * `ToolEvent.Progress` in real time.
 */
export type Tool<Name extends string, Input, Event, Output, R = never> = {
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly run: (input: Input, emit: Emit<Event>) => Effect.Effect<Output, unknown, R>
  /**
   * Bound on this tool's emit queue. Unbounded when omitted. Per-tool because
   * backpressure depends on how a given tool emits, unlike `concurrency`
   * (cross-tool, on `Toolkit.run`'s options).
   */
  readonly emitBufferSize?: number
  /**
   * Whether the provider should render this tool with its strict-mode
   * flag (OpenAI's `strict: true`, etc). Default: true. The framework
   * never rewrites the schema; if the rendered JSON Schema isn't
   * compatible, the provider returns an error.
   */
  readonly strict?: boolean
}

/** A tool of any shape. Readability alias, no longer a union. */
export type AnyTool<R = any> = Tool<string, any, any, any, R>

/**
 * Provider-agnostic tool descriptor. Each provider maps `inputSchema`
 * to its own wire field (OpenAI → `parameters`, Anthropic →
 * `input_schema`). Built from a `Tool` by `Tool.toDescriptors`.
 */
export type ToolDescriptor = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly strict?: boolean
}

export const make = <Name extends string, Input, Event, Output, R = never>(
  spec: Tool<Name, Input, Event, Output, R>,
): Tool<Name, Input, Event, Output, R> => spec

/**
 * Return a copy of a tool under a new `name`. Useful for resolving a name
 * clash before combining tools into one `Toolkit`. Literal-preserving, so the
 * renamed tool keys the toolkit record under the new name statically.
 */
export const withName = <N extends string, T extends AnyTool>(
  tool: T,
  name: N,
): Omit<T, "name"> & { readonly name: N } => ({ ...tool, name })

/** Render tools to provider-agnostic descriptors. */
export const toDescriptors = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolDescriptor> =>
  tools.map((tool) => {
    const inputSchema = tool.inputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    })
    return tool.strict !== undefined
      ? {
          name: tool.name,
          description: tool.description,
          inputSchema,
          strict: tool.strict,
        }
      : { name: tool.name, description: tool.description, inputSchema }
  })

const toToolError = (call: ToolCall, toolName: string, message: string) => (cause: unknown) =>
  new ToolError({ call_id: call.call_id, tool: toolName, message, cause })

/**
 * Decode and validate a function_call's JSON `arguments` against the tool's
 * own `inputSchema`, yielding the typed input. The decode-only half of
 * `execute` - reach for it when you intercept a call to translate it into a
 * control-flow decision rather than running the tool's `run`.
 *
 * Malformed JSON fails with `ToolError`; a parsed body that violates
 * `inputSchema` fails with `ToolValidationError` carrying the issues.
 */
export const decodeArgs = <Name extends string, Input, Event, Output, R>(
  tool: Tool<Name, Input, Event, Output, R>,
  call: ToolCall,
): Effect.Effect<Input, ToolError | ToolValidationError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(call.arguments) as unknown,
      catch: toToolError(call, tool.name, "Failed to parse JSON arguments"),
    })

    const result = yield* Effect.promise(() =>
      Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
    )
    if (result.issues !== undefined) {
      return yield* new ToolValidationError({
        call_id: call.call_id,
        tool: tool.name,
        issues: result.issues,
      })
    }
    return result.value
  })

/**
 * Decode and validate the JSON arguments of a function_call against the
 * tool's input schema, run the tool, and serialize the output into a
 * function_call_output item. Single-shot: intermediate events emitted by
 * `run` are discarded (use `Toolkit.run` to stream them).
 */
export const execute = <Name extends string, Input, Event, Output, R>(
  tool: Tool<Name, Input, Event, Output, R>,
  call: ToolCall,
): Effect.Effect<ToolCallOutput, ToolError | ToolValidationError, R> =>
  decodeArgs(tool, call).pipe(
    Effect.flatMap((input) =>
      tool
        .run(input, () => Effect.void)
        .pipe(Effect.mapError(toToolError(call, tool.name, "Tool execution failed"))),
    ),
    Effect.map((output) => toolCallOutput(call.call_id, JSON.stringify(output))),
  )
