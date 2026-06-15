import { Array as Arr, Cause, Effect, Fiber, Function, Queue, Ref, Schema, Stream } from "effect"
import * as Loop from "../loop/Loop.js"
import type { HistoryItem, ToolCall } from "../domain/Items.js"
import { appendToHistory, type Turn } from "../domain/Turn.js"
import { type AnyTool, type ToolDescriptor, toDescriptors } from "./Tool.js"
import {
  ToolResult,
  executionError,
  failed,
  toToolCallOutput,
  validationError,
} from "./ToolResult.js"
import { ToolEvent } from "./ToolEvent.js"
import { isOutput } from "./ToolEvent.js"

// ---------------------------------------------------------------------------
// Toolkit: a name-indexed record of tools — "what the model sees". Composing
// reusable toolkits is native array/object work (concat / spread / map);
// `make`/`fromArray` are just the indexer. Descriptors are derived, not stored.
// Duplicate names resolve last-wins; resolve clashes with `Tool.withName`.
// ---------------------------------------------------------------------------

export type ToolMap = Record<string, AnyTool>

export type Toolkit<Tools extends ToolMap = ToolMap> = Tools

const indexByName = (tools: ReadonlyArray<AnyTool>): ToolMap =>
  Object.fromEntries(tools.map((tool) => [tool.name, tool]))

/** Index tools by their literal `name`. */
export const make = <const Tools extends ReadonlyArray<AnyTool>>(
  ...tools: Tools
): Toolkit<{ [T in Tools[number] as T["name"]]: T }> =>
  indexByName(tools) as Toolkit<{ [T in Tools[number] as T["name"]]: T }>

/** Same as `make`, from a dynamically-built array (MCP tools, etc.). */
export const fromArray = (tools: ReadonlyArray<AnyTool>): Toolkit => indexByName(tools)

/** Render the provider-facing descriptors for a toolkit on demand. */
export const descriptors = (toolkit: Toolkit): ReadonlyArray<ToolDescriptor> =>
  toDescriptors(Object.values(toolkit))

/**
 * Union of every tool's `R` requirements in a toolkit. Surfaced by `run` so the
 * loop's stream type carries the services tools need through to `Effect.provide`.
 *
 * The `ToolMap extends T` guard yields `never` for the wide `Toolkit` type (a
 * toolkit passed through an untyped boundary, where the requirements aren't
 * statically known) instead of `any`, which would otherwise poison the
 * resulting stream's `R`. Concrete toolkits from `make` keep their precise R.
 */
export type ToolkitR<T extends Toolkit> = ToolMap extends T
  ? never
  : T[keyof T] extends AnyTool<infer R>
    ? R
    : never

// ---------------------------------------------------------------------------
// Tool executor. Streams `ToolEvent`s in real time. Policy stays outside this
// module: callers pass only the calls they have already decided should run.
// ---------------------------------------------------------------------------

export type ExecuteOptions = {
  readonly concurrency?: number | "unbounded"
}

/** Execute every provided call. Approval/rejection policy belongs upstream. */
export const run = <T extends Toolkit>(
  toolkit: T,
  calls: ReadonlyArray<ToolCall>,
  options?: ExecuteOptions,
): Stream.Stream<ToolEvent, never, ToolkitR<T>> =>
  Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) => runOne(toolkit, call), {
      concurrency: options?.concurrency ?? "unbounded",
    }),
  ) as Stream.Stream<ToolEvent, never, ToolkitR<T>>

const okResult = (call: ToolCall, tool: string, value: unknown): ToolResult =>
  ToolResult.Ok({ call_id: call.call_id, tool, value })

const runOne = (toolkit: ToolMap, call: ToolCall): Stream.Stream<ToolEvent, never, any> => {
  const tool = toolkit[call.name]
  if (tool === undefined) {
    // Graceful: emit a synthetic Failure so OTHER calls in this turn still
    // execute. LLMs hallucinate tool names; MCP tools come and go.
    return Stream.succeed(
      ToolEvent.Output({
        result: failed(call, "unknown_tool", `No tool registered with name "${call.name}"`),
      }),
    )
  }
  return runTool(tool, call)
}

const parseJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const runTool = (tool: AnyTool, call: ToolCall): Stream.Stream<ToolEvent, never, any> =>
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
        return Stream.succeed<ToolEvent>(ToolEvent.Output({ result: validationError(call) }))
      }

      // Per-call queue: `emit` offers events as `run` produces them; the
      // progress stream drains them in real time; `Queue.end` (in the
      // `ensuring`) flushes pending events then signals a clean end, which
      // `Stream.fromQueue` treats as completion. `Queue.shutdown` would clear
      // queued items and interrupt pending takes — wrong for graceful teardown.
      const queue = yield* Queue.make<unknown, Cause.Done>({ capacity: tool.emitBufferSize })
      const emit = (event: unknown) => Effect.asVoid(Queue.offer(queue, event))
      const fiber = yield* tool
        .run(validated.value, emit)
        .pipe(Effect.ensuring(Queue.end(queue)), Effect.forkScoped)

      const progress = Stream.fromQueue(queue).pipe(
        Stream.map((data) => ToolEvent.Progress({ call_id: call.call_id, tool: tool.name, data })),
      )
      const output = Stream.fromEffect(
        Fiber.join(fiber).pipe(
          Effect.map((value) => ToolEvent.Output({ result: okResult(call, tool.name, value) })),
          Effect.catchCause(() =>
            Effect.succeed(
              ToolEvent.Output({ result: executionError(call, "Tool execution failed") }),
            ),
          ),
        ),
      )
      return progress.pipe(Stream.concat(output))
    }),
  ).pipe(
    // Backstop for the input-parsing failures (`json_parse_error`,
    // `validation_threw`) and any defect before the run fiber is forked.
    Stream.catchCause(() =>
      Stream.succeed(ToolEvent.Output({ result: executionError(call, "Tool execution failed") })),
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
 *   Toolkit.run(toolkit, calls).pipe(
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
