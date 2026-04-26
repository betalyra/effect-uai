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

export interface Tool<Name extends string, Input, Output, R = never> {
  readonly name: Name
  readonly description: string
  readonly inputSchema: Schema.Codec<Input, any>
  readonly run: (input: Input) => Effect.Effect<Output, unknown, R>
}

export const make = <Name extends string, Input, Output, R = never>(
  spec: Tool<Name, Input, Output, R>
): Tool<Name, Input, Output, R> => spec

/**
 * Decode the JSON arguments of a function_call against a tool's input schema,
 * run the tool, and serialize the output into a function_call_output item.
 */
export const execute = <Name extends string, Input, Output, R>(
  tool: Tool<Name, Input, Output, R>,
  call: FunctionCall
): Effect.Effect<FunctionCallOutput, ToolError, R> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(call.arguments) as unknown,
      catch: (cause) =>
        new ToolError({
          call_id: call.call_id,
          tool: tool.name,
          message: "Failed to parse JSON arguments",
          cause
        })
    })
    const input = yield* Schema.decodeUnknownEffect(tool.inputSchema)(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new ToolError({
            call_id: call.call_id,
            tool: tool.name,
            message: "Tool input failed schema validation",
            cause
          })
      )
    )
    const output = yield* tool.run(input).pipe(
      Effect.mapError(
        (cause) =>
          new ToolError({
            call_id: call.call_id,
            tool: tool.name,
            message: "Tool execution failed",
            cause
          })
      )
    )
    return functionCallOutput(call.call_id, JSON.stringify(output))
  })
