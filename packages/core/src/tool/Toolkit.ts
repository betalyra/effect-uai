import { Array as Arr, Effect, Function, Ref, Stream } from "effect"
import * as Loop from "../loop/Loop.js"
import type { FunctionCall } from "../domain/Items.js"
import {
  type AnyKindTool,
  type AnyPlainTool,
  type AnyStreamingTool,
  isStreamingTool,
  type StreamingTool,
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

/**
 * Union of every tool's `R` requirements in a mixed plain + streaming array.
 * Used by `executeAll` to surface the services tools need at the recipe
 * level, so the loop's stream type carries them through to `Effect.provide`.
 */
export type ToolKindR<Tools extends ReadonlyArray<AnyKindTool<any>>> =
  Tools[number] extends StreamingTool<any, any, any, any, infer R>
    ? R
    : Tools[number] extends Tool<any, any, any, infer R>
      ? R
      : never

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
export const executeAll = <Tools extends ReadonlyArray<AnyKindTool<any>>>(
  tools: Tools,
  calls: ReadonlyArray<FunctionCall>,
  options?: ExecuteOptions,
): Stream.Stream<ToolEvent, never, ToolKindR<Tools>> =>
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

const runOne = <R>(
  tools: ReadonlyArray<AnyKindTool<R>>,
  call: FunctionCall,
): Stream.Stream<ToolEvent, never, R> => {
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

const runPlain = <R>(
  tool: AnyPlainTool<R>,
  call: FunctionCall,
): Stream.Stream<ToolEvent, never, R> =>
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

const runStreaming = <R>(
  tool: AnyStreamingTool<R>,
  call: FunctionCall,
): Stream.Stream<ToolEvent, never, R> =>
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
// `continueWith` - bridge from a `Stream<ToolEvent>` to the loop's emit
// shape. Drains the stream to the consumer in real-time, taps every
// `Output` into an internal Ref, and at end-of-stream emits
// `Loop.next(build(results))`. Recipe never sees the Ref.
//
// Dual: data-first `continueWith(stream, build)` and data-last
// `stream.pipe(continueWith(build))` both work.
// ---------------------------------------------------------------------------

export const continueWith: {
  <S>(
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): <R>(
    stream: Stream.Stream<ToolEvent, never, R>,
  ) => Stream.Stream<Loop.Event<ToolEvent, S>, never, R>
  <S, R>(
    stream: Stream.Stream<ToolEvent, never, R>,
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): Stream.Stream<Loop.Event<ToolEvent, S>, never, R>
} = Function.dual(
  2,
  <S, R>(
    stream: Stream.Stream<ToolEvent, never, R>,
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): Stream.Stream<Loop.Event<ToolEvent, S>, never, R> =>
    Loop.nextAfterFold(
      stream,
      [] as ReadonlyArray<ToolResult>,
      (acc, e) => (isOutput(e) ? Arr.append(acc, e.result) : acc),
      build,
    ),
)
