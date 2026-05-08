import { Array as Arr, Effect, Ref, Stream } from "effect"
import * as Loop from "../loop/Loop.js"
import type { FunctionCall } from "../domain/Items.js"
import {
  type AnyKindTool,
  type AnyPlainTool,
  type AnyStreamingTool,
  isStreamingTool,
  type Tool,
  type ToolDescriptor,
} from "./Tool.js"
import { type ToolResult, executionError, rejected } from "./Outcome.js"
import type { ToolEvent } from "./ToolEvent.js"
import { isOutput } from "./ToolEvent.js"

export type AnyTool = Tool<string, any, any, any>

export type Toolkit<Tools extends ReadonlyArray<AnyTool>> = {
  readonly tools: Tools
}

export type ToolsR<Tools extends ReadonlyArray<AnyTool>> =
  Tools[number] extends Tool<any, any, any, infer R> ? R : never

export const make = <const Tools extends ReadonlyArray<AnyTool>>(tools: Tools): Toolkit<Tools> => ({
  tools,
})

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

// ---------------------------------------------------------------------------
// Tool executor. Streams `ToolEvent`s in real time and dispatches streaming
// and plain tools uniformly. Policy stays outside this module: callers pass
// only the calls they have already decided should run.
// ---------------------------------------------------------------------------

export type ExecuteOptions = {
  readonly concurrency?: number | "unbounded"
}

/** Execute every provided call. Approval/rejection policy belongs upstream. */
export const executeAll = (
  tools: ReadonlyArray<AnyKindTool>,
  calls: ReadonlyArray<FunctionCall>,
  options?: ExecuteOptions,
): Stream.Stream<ToolEvent> =>
  Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) => runOne(tools, call), {
      concurrency: options?.concurrency ?? "unbounded",
    }),
  )

export const outputEvent = (result: ToolResult): ToolEvent => ({ _tag: "Output", result })

export const outputEvents = (results: ReadonlyArray<ToolResult>): Stream.Stream<ToolEvent> =>
  Stream.fromIterable(results.map(outputEvent))

const valueResult = (call: FunctionCall, tool: string, value: unknown): ToolResult => ({
  _tag: "Value",
  call_id: call.call_id,
  tool,
  value,
})

const runOne = (
  tools: ReadonlyArray<AnyKindTool>,
  call: FunctionCall,
): Stream.Stream<ToolEvent> => {
  const tool = tools.find((t) => t.name === call.name)
  if (tool === undefined) {
    // Graceful: emit a synthetic Failure so OTHER calls in this turn
    // still execute. LLMs hallucinate tool names; MCP tools come and go.
    return Stream.succeed<ToolEvent>({
      _tag: "Output",
      result: rejected(call, "unknown_tool", `No tool registered with name "${call.name}"`),
    })
  }
  if (isStreamingTool(tool)) return runStreaming(tool, call)
  return runPlain(tool, call)
}

const runPlain = (tool: AnyPlainTool, call: FunctionCall): Stream.Stream<ToolEvent> =>
  Stream.fromEffect(
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(call.arguments) as unknown,
        catch: () => "json_parse_error" as const,
      })
      const validated = yield* Effect.tryPromise({
        try: () => Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
        catch: () => "validation_threw" as const,
      })
      if (validated.issues !== undefined) {
        return executionError(call, "Tool input failed schema validation")
      }
      const output = yield* tool.run(validated.value)
      return valueResult(call, tool.name, output)
    }).pipe(
      Effect.catchCause(() => Effect.succeed(executionError(call, "Tool execution failed"))),
      Effect.map((result) => ({ _tag: "Output", result }) satisfies ToolEvent),
    ),
  )

const runStreaming = (tool: AnyStreamingTool, call: FunctionCall): Stream.Stream<ToolEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(call.arguments) as unknown,
        catch: () => "json_parse_error" as const,
      })
      const validated = yield* Effect.tryPromise({
        try: () => Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
        catch: () => "validation_threw" as const,
      })
      if (validated.issues !== undefined) {
        return Stream.succeed<ToolEvent>({
          _tag: "Output",
          result: executionError(call, "Tool input failed schema validation"),
        })
      }

      // Real-time: tap each event into a Ref as it flows; emit one
      // Intermediate per event; then concat one synthetic Output element
      // built from the accumulated Ref via `finalize`.
      const ref = yield* Ref.make<Array<unknown>>([])
      const intermediates = tool.run(validated.value).pipe(
        Stream.tap((event) => Ref.update(ref, Arr.append(event))),
        Stream.map(
          (data) =>
            ({
              _tag: "Intermediate",
              call_id: call.call_id,
              tool: tool.name,
              data,
            }) satisfies ToolEvent,
        ),
      )
      const output = Stream.fromEffect(
        Ref.get(ref).pipe(
          Effect.map(
            (events) =>
              ({
                _tag: "Output",
                result: valueResult(call, tool.name, tool.finalize(events)),
              }) satisfies ToolEvent,
          ),
        ),
      )
      return intermediates.pipe(Stream.concat(output))
    }),
  ).pipe(
    Stream.catchCause(() =>
      Stream.succeed<ToolEvent>({
        _tag: "Output",
        result: executionError(call, "Tool execution failed"),
      }),
    ),
  )

// ---------------------------------------------------------------------------
// `nextStateFrom` - bridge from a `Stream<ToolEvent>` to the loop's emit
// shape. Drains the stream to the consumer in real-time, taps every
// `Output` into an internal Ref, and at end-of-stream emits
// `Loop.next(build(results))`. Recipe never sees the Ref.
// ---------------------------------------------------------------------------

export const nextStateFrom = <S>(
  stream: Stream.Stream<ToolEvent>,
  build: (results: ReadonlyArray<ToolResult>) => S,
): Stream.Stream<Loop.Event<ToolEvent, S>> =>
  Loop.nextAfterFold(
    stream,
    [] as ReadonlyArray<ToolResult>,
    (acc, e) => (isOutput(e) ? Arr.append(acc, e.result) : acc),
    build,
  )
