import { Array as Arr, Effect, Function, Ref, Schema, Stream } from "effect"
import * as Loop from "../loop/Loop.js"
import type { FunctionCall, Item } from "../domain/Items.js"
import { appendTurn, type Turn } from "../domain/Turn.js"
import {
  type AnyKindTool,
  type AnyPlainTool,
  type AnyStreamingTool,
  isStreamingTool,
  type StreamingTool,
  type Tool,
  type ToolDescriptor,
} from "./Tool.js"
import { ToolResult, executionError, rejected, toFunctionCallOutput } from "./Outcome.js"
import { ToolEvent } from "./ToolEvent.js"
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
      ? {
          name: tool.name,
          description: tool.description,
          inputSchema,
          strict: tool.strict,
        }
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

const valueResult = (call: FunctionCall, tool: string, value: unknown): ToolResult =>
  ToolResult.Value({
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
    return Stream.succeed(
      ToolEvent.Output({
        result: rejected(call, "unknown_tool", `No tool registered with name "${call.name}"`),
      }),
    )
  }
  if (isStreamingTool(tool)) return runStreaming(tool, call)
  return runPlain(tool, call)
}

const parseJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const runPlain = <R>(
  tool: AnyPlainTool<R>,
  call: FunctionCall,
): Stream.Stream<ToolEvent, never, R> =>
  Stream.fromEffect(
    Effect.gen(function* () {
      const parsed = yield* parseJsonUnknown(call.arguments).pipe(
        Effect.mapError(() => "json_parse_error" as const),
      )
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
      Effect.map((result) => ToolEvent.Output({ result })),
    ),
  )

const runStreaming = <R>(
  tool: AnyStreamingTool<R>,
  call: FunctionCall,
): Stream.Stream<ToolEvent, never, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const parsed = yield* parseJsonUnknown(call.arguments).pipe(
        Effect.mapError(() => "json_parse_error" as const),
      )
      const validated = yield* Effect.tryPromise({
        try: () => Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
        catch: () => "validation_threw" as const,
      })
      if (validated.issues !== undefined) {
        return Stream.succeed<ToolEvent>(
          ToolEvent.Output({
            result: executionError(call, "Tool input failed schema validation"),
          }),
        )
      }

      // Real-time: tap each event into a Ref as it flows; emit one
      // Intermediate per event; then concat one synthetic Output element
      // built from the accumulated Ref via `finalize`.
      const ref = yield* Ref.make<Array<unknown>>([])
      const intermediates = tool.run(validated.value).pipe(
        Stream.tap((event) => Ref.update(ref, Arr.append(event))),
        Stream.map((data) =>
          ToolEvent.Intermediate({
            call_id: call.call_id,
            tool: tool.name,
            data,
          }),
        ),
      )
      const output = Stream.fromEffect(
        Ref.get(ref).pipe(
          Effect.map((events) =>
            ToolEvent.Output({
              result: valueResult(call, tool.name, tool.finalize(events)),
            }),
          ),
        ),
      )
      return intermediates.pipe(Stream.concat(output))
    }),
  ).pipe(
    Stream.catchCause(() =>
      Stream.succeed(
        ToolEvent.Output({
          result: executionError(call, "Tool execution failed"),
        }),
      ),
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

/**
 * Append a completed turn plus tool results to a state's history, converting
 * the results to wire-format `FunctionCallOutput`s. Curried so it slots
 * directly into `Effect.map` after `collectResults`:
 *
 *   stream.pipe(
 *     Toolkit.collectResults,
 *     Effect.map(Toolkit.appendToolResults(state, turn)),
 *     Loop.emitNext,
 *   )
 *
 * Equivalent to `appendTurn(state, turn, results.map(toFunctionCallOutput))`
 * — the helper just hides the wire-conversion step.
 */
export const appendToolResults = <S extends { readonly history: ReadonlyArray<Item> }>(
  state: S,
  turn: Turn,
) =>
  (results: ReadonlyArray<ToolResult>): S =>
    appendTurn(state, turn, results.map(toFunctionCallOutput))

/**
 * Drain a `Stream<ToolEvent>` and return the accumulated `ToolResult`s
 * from every `Output` event. One-shot — the type is `Effect<results>`,
 * not a one-element stream — so it composes naturally with `Effect.map`
 * to build state and `Loop.emitNext` to lift back into the loop emit
 * shape when broadcasting.
 *
 * Counterpart to `continueWith`: `continueWith` bundles drain + emit Next
 * into one bridge; this one is the right arm of a broadcast/fork-and-merge
 * for callers that want to vary the left arm (e.g., filter/tap ToolEvents
 * before forwarding).
 */
export const collectResults = <E, R>(
  stream: Stream.Stream<ToolEvent, E, R>,
): Effect.Effect<ReadonlyArray<ToolResult>, E, R> =>
  Stream.runFold(
    stream,
    () => [] as ReadonlyArray<ToolResult>,
    (acc, e) => (isOutput(e) ? Arr.append(acc, e.result) : acc),
  )

/**
 * Bridge from a `Stream<ToolEvent>` to the loop's emit shape. Forwards
 * every ToolEvent downstream as a `Loop.value` and at end-of-stream emits
 * one `Loop.next(build(results))` carrying the accumulated `ToolResult`s
 * from terminal `Output` events.
 *
 * Conceptually a broadcast fork (one arm passes events through, the other
 * drains them into a state). Implemented as a single-pass Ref tap + concat
 * for zero buffering — the broadcast version is observationally equivalent
 * but holds events in a PubSub until both arms drain. The public primitives
 * (`Loop.emitValues`, `collectResults`, `Loop.emitNext`) compose the same
 * pattern when you need to vary an arm.
 *
 * Dual: data-first `continueWith(stream, build)` and data-last
 * `stream.pipe(continueWith(build))` both work.
 */
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
    Stream.unwrap(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<ToolResult>>([])
        const tapped = stream.pipe(
          Stream.tap((e) =>
            isOutput(e) ? Ref.update(ref, (acc) => Arr.append(acc, e.result)) : Effect.void,
          ),
          Stream.map(Loop.value),
        )
        const continuation = Stream.fromEffect(
          Ref.get(ref).pipe(Effect.map((acc) => Loop.next(build(acc)))),
        )
        return tapped.pipe(Stream.concat(continuation))
      }),
    ),
)
