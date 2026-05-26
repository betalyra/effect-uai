import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Schema, Stream } from "effect"
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
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema)) as unknown as S &
    ToolInputSchema<S["Type"]>

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

export type Tool<Name extends string, Input, Output, R = never> = {
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly run: (input: Input) => Effect.Effect<Output, unknown, R>
  /**
   * Whether the provider should render this tool with its strict-mode
   * flag (OpenAI's `strict: true`, etc). Default: true. The framework
   * never rewrites the schema; if the rendered JSON Schema isn't
   * compatible, the provider returns an error.
   */
  readonly strict?: boolean
}

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

export const make = <Name extends string, Input, Output, R = never>(
  spec: Tool<Name, Input, Output, R>,
): Tool<Name, Input, Output, R> => spec

// ---------------------------------------------------------------------------
// Streaming tools
//
// `run` returns a `Stream<Event>` instead of an `Effect<Output>`. Events
// flow through to the consumer as `ToolEvent.Progress`s in real time;
// at end-of-stream `finalize(events)` reduces them to the model-facing
// `Output`. Sub-agents, slow downloads with progress, recipe streamers.
// ---------------------------------------------------------------------------

export type StreamingTool<Name extends string, Input, Event, Output, R = never> = {
  readonly _kind: "streaming"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly run: (input: Input) => Stream.Stream<Event, unknown, R>
  readonly finalize: (events: ReadonlyArray<Event>) => Output
  readonly strict?: boolean
}

export const streaming = <Name extends string, Input, Event, Output, R = never>(
  spec: Omit<StreamingTool<Name, Input, Event, Output, R>, "_kind">,
): StreamingTool<Name, Input, Event, Output, R> => ({ _kind: "streaming", ...spec })

export type AnyStreamingTool<R = any> = StreamingTool<string, any, any, any, R>
export type AnyPlainTool<R = any> = Tool<string, any, any, R>
export type AnyTool<R = any> = AnyStreamingTool<R> | AnyPlainTool<R>

export const isStreamingTool = <R>(t: AnyTool<R>): t is AnyStreamingTool<R> =>
  "_kind" in t && t._kind === "streaming"

/**
 * Render any-kind tools (mixed plain and streaming) to provider-agnostic
 * descriptors. Accepts the union type so a single list can carry both
 * plain and streaming tools.
 */
export const toDescriptors = <R>(
  tools: ReadonlyArray<AnyTool<R>>,
): ReadonlyArray<ToolDescriptor> =>
  tools.map((tool) => {
    const inputSchema = tool.inputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    })
    return tool.strict !== undefined
      ? { name: tool.name, description: tool.description, inputSchema, strict: tool.strict }
      : { name: tool.name, description: tool.description, inputSchema }
  })

const toToolError = (call: ToolCall, toolName: string, message: string) => (cause: unknown) =>
  new ToolError({ call_id: call.call_id, tool: toolName, message, cause })

/**
 * Decode and validate the JSON arguments of a function_call against the
 * tool's input schema, run the tool, and serialize the output into a
 * function_call_output item.
 */
export const execute = <Name extends string, Input, Output, R>(
  tool: Tool<Name, Input, Output, R>,
  call: ToolCall,
): Effect.Effect<ToolCallOutput, ToolError, R> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(call.arguments) as unknown,
      catch: toToolError(call, tool.name, "Failed to parse JSON arguments"),
    })

    const result = yield* Effect.promise(() =>
      Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
    )
    if (result.issues !== undefined) {
      return yield* new ToolError({
        call_id: call.call_id,
        tool: tool.name,
        message: "Tool input failed schema validation",
        cause: result.issues,
      })
    }

    const output = yield* tool
      .run(result.value)
      .pipe(Effect.mapError(toToolError(call, tool.name, "Tool execution failed")))
    return toolCallOutput(call.call_id, JSON.stringify(output))
  })
