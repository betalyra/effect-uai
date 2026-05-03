/**
 * Library: real-time tool execution dispatched by a `Resolver`.
 *
 * `executeWithResolver` is the lowest-level primitive. For each call it
 * asks the resolver for a `ToolDecision`, then:
 *
 *   - Execute        → runs the tool with `call.arguments`
 *   - Reject(result) → emits a single Output event carrying the supplied
 *                      synthetic `ToolResult`
 *
 * Streaming and non-streaming tools dispatch identically inside `runOne`
 * via `isStreamingTool`. The resolver knows nothing about whether a tool
 * streams; that's an execution detail.
 *
 * Output events carry `ToolResult` (structured). Recipes apply
 * `toFunctionCallOutput` at the boundary when threading into history.
 *
 * `executeAllSafe` is just `executeWithResolver(tools, calls, () => execute)`.
 */
import { Array as Arr, Effect, Match, Ref, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import {
  type AnyKindTool,
  type AnyPlainTool,
  type AnyStreamingTool,
  isStreamingTool,
} from "./StreamingTool.js"
import { type ToolDecision, type ToolResult, execute, executionError } from "./Outcome.js"
import type { ToolEvent } from "./ToolEvent.js"

export type Resolver = (call: Items.FunctionCall) => Effect.Effect<ToolDecision>

export const executeWithResolver = (
  tools: ReadonlyArray<AnyKindTool>,
  calls: ReadonlyArray<Items.FunctionCall>,
  resolve: Resolver,
): Stream.Stream<ToolEvent> =>
  Stream.fromIterable(calls).pipe(
    Stream.flatMap(
      (call) =>
        Stream.unwrap(
          resolve(call).pipe(
            Effect.map((decision) => dispatch(tools, call, decision)),
          ),
        ),
      { concurrency: "unbounded" },
    ),
  )

/** `executeAllSafe` is a degenerate `executeWithResolver` with `Execute` for all. */
export const executeAllSafe = (
  tools: ReadonlyArray<AnyKindTool>,
  calls: ReadonlyArray<Items.FunctionCall>,
): Stream.Stream<ToolEvent> =>
  executeWithResolver(tools, calls, () => Effect.succeed(execute))

// ---------------------------------------------------------------------------
// Decision dispatch.
// ---------------------------------------------------------------------------

const dispatch = (
  tools: ReadonlyArray<AnyKindTool>,
  call: Items.FunctionCall,
  decision: ToolDecision,
): Stream.Stream<ToolEvent> =>
  Match.value(decision).pipe(
    Match.tag("Execute", () => runOne(tools, call)),
    Match.tag("Reject", (d) =>
      Stream.succeed<ToolEvent>({ _tag: "Output", result: d.result }),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Per-call execution.
// ---------------------------------------------------------------------------

const value = (call: Items.FunctionCall, tool: string, value: unknown): ToolResult => ({
  _tag: "Value",
  call_id: call.call_id,
  tool,
  value,
})

const runOne = (
  tools: ReadonlyArray<AnyKindTool>,
  call: Items.FunctionCall,
): Stream.Stream<ToolEvent> => {
  const tool = tools.find((t) => t.name === call.name)
  if (tool === undefined) {
    return Stream.fromEffect(Effect.die(`Unknown tool: ${call.name}`))
  }
  if (isStreamingTool(tool)) return runStreaming(tool, call)
  return runPlain(tool, call)
}

const runPlain = (
  tool: AnyPlainTool,
  call: Items.FunctionCall,
): Stream.Stream<ToolEvent> =>
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
      return value(call, tool.name, output)
    }).pipe(
      Effect.catchCause(() => Effect.succeed(executionError(call, "Tool execution failed"))),
      Effect.map((result) => ({ _tag: "Output", result }) satisfies ToolEvent),
    ),
  )

const runStreaming = (
  tool: AnyStreamingTool,
  call: Items.FunctionCall,
): Stream.Stream<ToolEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(call.arguments),
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

      const ref = yield* Ref.make<ReadonlyArray<unknown>>([])
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
                result: value(call, tool.name, tool.finalize(events as ReadonlyArray<any>)),
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
