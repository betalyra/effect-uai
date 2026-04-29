import { Effect } from "effect"
import { functionCallOutput, type FunctionCall, type FunctionCallOutput } from "../domain/Items.js"
import { execute, type Tool, type ToolDescriptor, type ToolError } from "./Tool.js"

export type AnyTool = Tool<string, any, any, any>

export type Toolkit<Tools extends ReadonlyArray<AnyTool>> = {
  readonly tools: Tools
}

export type ToolsR<Tools extends ReadonlyArray<AnyTool>> =
  Tools[number] extends Tool<any, any, any, infer R> ? R : never

export const make = <const Tools extends ReadonlyArray<AnyTool>>(tools: Tools): Toolkit<Tools> => ({
  tools,
})

const findTool = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>,
  name: string,
): AnyTool | undefined => toolkit.tools.find((t) => t.name === name)

export const executeOne = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>,
  call: FunctionCall,
): Effect.Effect<FunctionCallOutput, ToolError, ToolsR<Tools>> => {
  const tool = findTool(toolkit, call.name)
  if (tool === undefined) {
    return Effect.die(`Unknown tool: ${call.name}`)
  }
  return execute(tool, call) as Effect.Effect<FunctionCallOutput, ToolError, ToolsR<Tools>>
}

export const executeAll = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>,
  calls: ReadonlyArray<FunctionCall>,
  options?: { readonly concurrency?: number | "unbounded" },
): Effect.Effect<ReadonlyArray<FunctionCallOutput>, ToolError, ToolsR<Tools>> =>
  Effect.forEach(calls, (call) => executeOne(toolkit, call), {
    concurrency: options?.concurrency ?? "unbounded",
  })

/**
 * Default repair: turn a `ToolError` into a `FunctionCallOutput` carrying a
 * structured JSON error payload. The model reads it on the next turn and
 * self-corrects (e.g. retries with the right argument names). Override by
 * passing your own `onError` to `executeAllSafe`.
 */
export const defaultRepair = (err: ToolError, call: FunctionCall): FunctionCallOutput =>
  functionCallOutput(
    call.call_id,
    JSON.stringify({
      error: "argument_validation_failed",
      tool: err.tool,
      message: err.message,
    }),
  )

/**
 * Like `executeAll`, but per-call `ToolError`s are caught and translated by
 * `onError` (defaults to `defaultRepair`) into a `FunctionCallOutput` that
 * can be appended to the history and fed back to the model.
 *
 * Defects (e.g. unknown tool name) are NOT caught - those are programming
 * errors, not model errors.
 */
export const executeAllSafe = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>,
  calls: ReadonlyArray<FunctionCall>,
  onError: (err: ToolError, call: FunctionCall) => FunctionCallOutput = defaultRepair,
  options?: { readonly concurrency?: number | "unbounded" },
): Effect.Effect<ReadonlyArray<FunctionCallOutput>, never, ToolsR<Tools>> =>
  Effect.forEach(
    calls,
    (call) =>
      executeOne(toolkit, call).pipe(
        Effect.catchTag("ToolError", (err) => Effect.succeed(onError(err, call))),
      ),
    { concurrency: options?.concurrency ?? "unbounded" },
  )

/**
 * Render every tool in a toolkit to a provider-agnostic descriptor.
 * `inputSchema` is the JSON Schema document produced by the tool's
 * Standard Schema converter (draft 2020-12).
 */
export const toDescriptors = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>,
): ReadonlyArray<ToolDescriptor> =>
  toolkit.tools.map((tool) => {
    const inputSchema = tool.inputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    })
    return tool.strict !== undefined
      ? { name: tool.name, description: tool.description, inputSchema, strict: tool.strict }
      : { name: tool.name, description: tool.description, inputSchema }
  })
