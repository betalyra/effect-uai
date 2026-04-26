import type {
  StandardJSONSchemaV1,
  StandardSchemaV1
} from "@standard-schema/spec"
import { Effect, Schema } from "effect"
import type { FunctionCall, FunctionCallOutput } from "./Items.js"
import { functionCallOutput } from "./Items.js"

export class ToolError extends Schema.TaggedErrorClass<ToolError>(
  "@betalyra/effect-uai/ToolError"
)("ToolError", {
  call_id: Schema.String,
  tool: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
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
export type ToolInputSchema<Input = unknown> =
  StandardSchemaV1<unknown, Input> & StandardJSONSchemaV1<unknown, Input>

/**
 * Convenience wrapper for Effect Schema users — adds both the
 * `validate` and `jsonSchema` extensions to a plain Effect Schema so it
 * can be used as a `Tool.inputSchema`.
 */
export const fromEffectSchema = <S extends Schema.Codec<any, any, never, any>>(
  schema: S
): S & ToolInputSchema<S["Type"]> =>
  Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(schema)
  ) as unknown as S & ToolInputSchema<S["Type"]>

export interface Tool<Name extends string, Input, Output, R = never> {
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
 * `input_schema`). Built from a `Tool` by `Toolkit.toDescriptors`.
 */
export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly strict?: boolean
}

export const make = <Name extends string, Input, Output, R = never>(
  spec: Tool<Name, Input, Output, R>
): Tool<Name, Input, Output, R> => spec

const toToolError = (
  call: FunctionCall,
  toolName: string,
  message: string
) =>
(cause: unknown) =>
  new ToolError({ call_id: call.call_id, tool: toolName, message, cause })

/**
 * Decode and validate the JSON arguments of a function_call against the
 * tool's input schema, run the tool, and serialize the output into a
 * function_call_output item.
 */
export const execute = <Name extends string, Input, Output, R>(
  tool: Tool<Name, Input, Output, R>,
  call: FunctionCall
): Effect.Effect<FunctionCallOutput, ToolError, R> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(call.arguments) as unknown,
      catch: toToolError(call, tool.name, "Failed to parse JSON arguments")
    })

    const result = yield* Effect.promise(() =>
      Promise.resolve(tool.inputSchema["~standard"].validate(parsed))
    )
    if (result.issues !== undefined) {
      return yield* new ToolError({
        call_id: call.call_id,
        tool: tool.name,
        message: "Tool input failed schema validation",
        cause: result.issues
      })
    }

    const output = yield* tool.run(result.value).pipe(
      Effect.mapError(toToolError(call, tool.name, "Tool execution failed"))
    )
    return functionCallOutput(call.call_id, JSON.stringify(output))
  })
