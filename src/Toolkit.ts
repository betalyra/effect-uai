import { Effect } from "effect"
import type { FunctionCall, FunctionCallOutput } from "./Items.js"
import {
  execute,
  type Tool,
  type ToolDescriptor,
  type ToolError
} from "./Tool.js"

export type AnyTool = Tool<string, any, any, any>

export type Toolkit<Tools extends ReadonlyArray<AnyTool>> = {
  readonly tools: Tools
}

export type ToolsR<Tools extends ReadonlyArray<AnyTool>> =
  Tools[number] extends Tool<any, any, any, infer R> ? R : never

export const make = <const Tools extends ReadonlyArray<AnyTool>>(
  tools: Tools
): Toolkit<Tools> => ({ tools })

const findTool = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>,
  name: string
): AnyTool | undefined => toolkit.tools.find((t) => t.name === name)

export const executeOne = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>,
  call: FunctionCall
): Effect.Effect<FunctionCallOutput, ToolError, ToolsR<Tools>> => {
  const tool = findTool(toolkit, call.name)
  if (tool === undefined) {
    return Effect.die(`Unknown tool: ${call.name}`)
  }
  return execute(tool, call) as Effect.Effect<
    FunctionCallOutput,
    ToolError,
    ToolsR<Tools>
  >
}

export const executeAll = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>,
  calls: ReadonlyArray<FunctionCall>,
  options?: { readonly concurrency?: number | "unbounded" }
): Effect.Effect<
  ReadonlyArray<FunctionCallOutput>,
  ToolError,
  ToolsR<Tools>
> =>
  Effect.forEach(calls, (call) => executeOne(toolkit, call), {
    concurrency: options?.concurrency ?? "unbounded"
  })

/**
 * Render every tool in a toolkit to a provider-agnostic descriptor.
 * `inputSchema` is the JSON Schema document produced by the tool's
 * Standard Schema converter (draft 2020-12).
 */
export const toDescriptors = <Tools extends ReadonlyArray<AnyTool>>(
  toolkit: Toolkit<Tools>
): ReadonlyArray<ToolDescriptor> =>
  toolkit.tools.map((tool) => {
    const inputSchema = tool.inputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12"
    })
    return tool.strict !== undefined
      ? { name: tool.name, description: tool.description, inputSchema, strict: tool.strict }
      : { name: tool.name, description: tool.description, inputSchema }
  })
