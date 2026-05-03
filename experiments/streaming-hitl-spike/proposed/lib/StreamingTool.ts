/**
 * Library: streaming tool constructor and the tagged-union of "any kind"
 * tool the executor can handle.
 *
 * In the framework this would extend `@effect-uai/core/Tool` with a new
 * `Tool.streaming` constructor and a `Tool.AnyKindTool` union covering
 * both plain and streaming tools.
 */
import type { Stream } from "effect"
import * as Tool from "@effect-uai/core/Tool"

export interface StreamingTool<Name extends string, Input, Event, Output, R = never> {
  readonly _kind: "streaming"
  readonly name: Name
  readonly description: string
  readonly inputSchema: Tool.ToolInputSchema<Input>
  readonly run: (input: Input) => Stream.Stream<Event, unknown, R>
  readonly finalize: (events: ReadonlyArray<Event>) => Output
  readonly strict?: boolean
}

export const streaming = <Name extends string, Input, Event, Output, R = never>(
  spec: Omit<StreamingTool<Name, Input, Event, Output, R>, "_kind">,
): StreamingTool<Name, Input, Event, Output, R> => ({ _kind: "streaming", ...spec })

export type AnyStreamingTool = StreamingTool<string, any, any, any, never>
export type AnyPlainTool = Tool.Tool<string, any, any, never>
export type AnyKindTool = AnyStreamingTool | AnyPlainTool

export const isStreamingTool = (t: AnyKindTool): t is AnyStreamingTool =>
  "_kind" in t && t._kind === "streaming"

/**
 * Render any-kind tools to a provider-agnostic descriptor. Mirrors
 * `Toolkit.toDescriptors` but accepts the union type so streaming and
 * plain tools share one list.
 */
export const toDescriptors = (
  tools: ReadonlyArray<AnyKindTool>,
): ReadonlyArray<Tool.ToolDescriptor> =>
  tools.map((tool) => {
    const inputSchema = tool.inputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    })
    return tool.strict !== undefined
      ? { name: tool.name, description: tool.description, inputSchema, strict: tool.strict }
      : { name: tool.name, description: tool.description, inputSchema }
  })
