import { Array as Arr, Effect, Function, Ref, Schema, Stream } from "effect"
import * as Loop from "../loop/Loop.js"
import type { ToolCall, HistoryItem } from "../domain/Items.js"
import { appendToHistory, type Turn } from "../domain/Turn.js"
import {
  type AnyTool,
  type AnyPlainTool,
  type AnyStreamingTool,
  isStreamingTool,
  type StreamingTool,
  type Tool,
} from "./Tool.js"
import { ToolResult, executionError, failed, toToolCallOutput } from "./ToolResult.js"
import { ToolEvent } from "./ToolEvent.js"
import { isOutput } from "./ToolEvent.js"

/**
 * Union of every tool's `R` requirements in a mixed plain + streaming array.
 * Used by `run` to surface the services tools need at the recipe level, so
 * the loop's stream type carries them through to `Effect.provide`.
 */
export type ToolKindR<Tools extends ReadonlyArray<AnyTool<any>>> =
  Tools[number] extends StreamingTool<any, any, any, any, infer R>
    ? R
    : Tools[number] extends Tool<any, any, any, infer R>
      ? R
      : never

// ---------------------------------------------------------------------------
// Tool executor. Streams `ToolEvent`s in real time and dispatches streaming
// and plain tools uniformly. Policy stays outside this module: callers pass
// only the calls they have already decided should run.
// ---------------------------------------------------------------------------

export type ExecuteOptions = {
  readonly concurrency?: number | "unbounded"
}

/** Execute every provided call. Approval/rejection policy belongs upstream. */
export const run = <Tools extends ReadonlyArray<AnyTool<any>>>(
  tools: Tools,
  calls: ReadonlyArray<ToolCall>,
  options?: ExecuteOptions,
): Stream.Stream<ToolEvent, never, ToolKindR<Tools>> =>
  Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) => runOne(tools, call), {
      concurrency: options?.concurrency ?? "unbounded",
    }),
  )

const okResult = (call: ToolCall, tool: string, value: unknown): ToolResult =>
  ToolResult.Ok({
    call_id: call.call_id,
    tool,
    value,
  })

const runOne = <R>(
  tools: ReadonlyArray<AnyTool<R>>,
  call: ToolCall,
): Stream.Stream<ToolEvent, never, R> => {
  const tool = tools.find((t) => t.name === call.name)
  if (tool === undefined) {
    // Graceful: emit a synthetic Failure so OTHER calls in this turn
    // still execute. LLMs hallucinate tool names; MCP tools come and go.
    return Stream.succeed(
      ToolEvent.Output({
        result: failed(call, "unknown_tool", `No tool registered with name "${call.name}"`),
      }),
    )
  }
  if (isStreamingTool(tool)) return runStreaming(tool, call)
  return runPlain(tool, call)
}

const parseJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const runPlain = <R>(tool: AnyPlainTool<R>, call: ToolCall): Stream.Stream<ToolEvent, never, R> =>
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
      return okResult(call, tool.name, output)
    }).pipe(
      Effect.catchCause(() => Effect.succeed(executionError(call, "Tool execution failed"))),
      Effect.map((result) => ToolEvent.Output({ result })),
    ),
  )

const runStreaming = <R>(
  tool: AnyStreamingTool<R>,
  call: ToolCall,
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
      // Progress per event; then concat one synthetic Output element
      // built from the accumulated Ref via `finalize`.
      const ref = yield* Ref.make<Array<unknown>>([])
      const progress = tool.run(validated.value).pipe(
        Stream.tap((event) => Ref.update(ref, Arr.append(event))),
        Stream.map((data) =>
          ToolEvent.Progress({
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
              result: okResult(call, tool.name, tool.finalize(events)),
            }),
          ),
        ),
      )
      return progress.pipe(Stream.concat(output))
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
// `continueWithResults` - bridge from a `Stream<ToolEvent>` to the loop's
// emit shape. Drains the stream to the consumer in real-time, taps every
// `Output` into an internal Ref, and at end-of-stream emits
// `Loop.next(build(results))`. Recipe never sees the Ref.
//
// Dual: data-first `continueWithResults(stream, build)` and data-last
// `stream.pipe(continueWithResults(build))` both work.
// ---------------------------------------------------------------------------

/**
 * Append a completed turn plus tool results to a state's history, converting
 * the results to wire-format `ToolCallOutput`s. Curried so it slots directly
 * into `continueWithResults`:
 *
 *   Toolkit.run(tools, calls).pipe(
 *     Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)),
 *   )
 *
 * Equivalent to `appendToHistory(state, turn, results.map(toToolCallOutput))`
 * — the helper just hides the wire-conversion step.
 */
export const appendToolResults =
  <S extends { readonly history: ReadonlyArray<HistoryItem> }>(state: S, turn: Turn) =>
  (results: ReadonlyArray<ToolResult>): S =>
    appendToHistory(state, turn, results.map(toToolCallOutput))

/**
 * Drain a `Stream<ToolEvent>` and return the accumulated `ToolResult`s
 * from every `Output` event. One-shot — the type is `Effect<results>`,
 * not a one-element stream — so it composes naturally with `Effect.map`
 * to build state.
 *
 * Counterpart to `continueWithResults`: `continueWithResults` bundles
 * drain + emit Next into one bridge; this one is the right arm of a
 * broadcast/fork-and-merge for callers that want to vary the left arm
 * (e.g., filter/tap ToolEvents before forwarding).
 */
export const collectResults = <E, R>(
  stream: Stream.Stream<ToolEvent, E, R>,
): Effect.Effect<ReadonlyArray<ToolResult>, E, R> =>
  stream.pipe(
    Stream.filter(isOutput),
    Stream.map((e) => e.result),
    Stream.runCollect,
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
 * (`Loop.value`, `collectResults`, `Loop.next`) compose the same pattern
 * when you need to vary an arm.
 *
 * Dual: data-first `continueWithResults(stream, build)` and data-last
 * `stream.pipe(continueWithResults(build))` both work.
 */
export const continueWithResults: {
  <S>(
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): <R>(
    stream: Stream.Stream<ToolEvent, never, R>,
  ) => Stream.Stream<Loop.Step<ToolEvent, S>, never, R>
  <S, R>(
    stream: Stream.Stream<ToolEvent, never, R>,
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): Stream.Stream<Loop.Step<ToolEvent, S>, never, R>
} = Function.dual(
  2,
  <S, R>(
    stream: Stream.Stream<ToolEvent, never, R>,
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): Stream.Stream<Loop.Step<ToolEvent, S>, never, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<ToolResult>>([])
        const tapped = stream.pipe(
          Stream.tap((e) =>
            isOutput(e) ? Ref.update(ref, (acc) => Arr.append(acc, e.result)) : Effect.void,
          ),
          Stream.map(Loop.value),
        )
        const continuation = Stream.unwrap(
          Ref.get(ref).pipe(Effect.map((acc) => Loop.next(build(acc)))),
        )
        return tapped.pipe(Stream.concat(continuation))
      }),
    ),
)
