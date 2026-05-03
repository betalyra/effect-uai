/**
 * Library: real-time tool execution with optional approval gating.
 *
 * `executeWithApproval(tools, calls, opts)` returns a `Stream<ToolEvent>`
 * that emits in arrival order:
 *   - `ApprovalRequested` per gated call (immediately; no work yet)
 *   - `Intermediate` per element from a streaming tool's `run` stream
 *   - `Output` terminating each call (success, denied, or error)
 *
 * Calls run concurrently. Verdicts arriving in any order are routed to
 * the matching call via per-call `Deferred<Verdict>`s pre-registered
 * before the router fiber starts.
 */
import { Array as Arr, Deferred, Effect, Queue, Ref, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import {
  type AnyKindTool,
  type AnyStreamingTool,
  isStreamingTool,
} from "./StreamingTool.js"
import type { ToolEvent } from "./ToolEvent.js"
import type { Verdict } from "./Verdict.js"

const deniedEvent = (call: Items.FunctionCall, reason: string | undefined): ToolEvent => ({
  _tag: "Output",
  output: Items.functionCallOutput(
    call.call_id,
    JSON.stringify({ kind: "denied", reason: reason ?? "denied by user" }),
  ),
})

const failedEvent = (
  call: Items.FunctionCall,
  toolName: string,
  message: string,
): ToolEvent => ({
  _tag: "Output",
  output: Items.functionCallOutput(
    call.call_id,
    JSON.stringify({ kind: "execution_error", tool: toolName, message }),
  ),
})

export const executeWithApproval = (
  tools: ReadonlyArray<AnyKindTool>,
  calls: ReadonlyArray<Items.FunctionCall>,
  opts: {
    readonly requiresApproval: (call: Items.FunctionCall) => boolean
    readonly verdicts: Queue.Dequeue<Verdict>
  },
): Stream.Stream<ToolEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Pre-register a Deferred per gated call BEFORE the router starts
      // taking from the queue, so no verdict can arrive without a target.
      const gated = calls.filter(opts.requiresApproval)
      const entries = yield* Effect.forEach(gated, (call) =>
        Deferred.make<Verdict>().pipe(
          Effect.map((d) => [call.call_id, d] as const),
        ),
      )
      const deferreds: ReadonlyMap<string, Deferred.Deferred<Verdict>> = new Map(entries)

      // Router: drain verdicts forever, resolve the matching Deferred.
      // Forked as a child of the surrounding scope so it dies when the
      // stream is cancelled or completes.
      yield* Effect.forkChild(
        Effect.forever(
          Effect.gen(function* () {
            const v = yield* Queue.take(opts.verdicts)
            const d = deferreds.get(v.call_id)
            if (d !== undefined) yield* Deferred.succeed(d, v)
          }),
        ),
      )

      return Stream.fromIterable(calls).pipe(
        Stream.flatMap(
          (call) =>
            opts.requiresApproval(call)
              ? runGated(tools, call, deferreds.get(call.call_id)!)
              : runOne(tools, call),
          { concurrency: "unbounded" },
        ),
      )
    }),
  )

const runGated = (
  tools: ReadonlyArray<AnyKindTool>,
  call: Items.FunctionCall,
  verdictDeferred: Deferred.Deferred<Verdict>,
): Stream.Stream<ToolEvent> =>
  Stream.fromIterable<ToolEvent>([
    {
      _tag: "ApprovalRequested",
      call_id: call.call_id,
      tool: call.name,
      arguments: call.arguments,
    },
  ]).pipe(
    Stream.concat(
      Stream.unwrap(
        Effect.gen(function* () {
          const verdict = yield* Deferred.await(verdictDeferred)
          if (verdict.decision === "deny") {
            return Stream.fromIterable<ToolEvent>([deniedEvent(call, verdict.reason)])
          }
          return runOne(tools, call)
        }),
      ),
    ),
  )

const runOne = (
  tools: ReadonlyArray<AnyKindTool>,
  call: Items.FunctionCall,
): Stream.Stream<ToolEvent> => {
  const tool = tools.find((t) => t.name === call.name)
  if (tool === undefined) {
    return Stream.fromEffect(Effect.die(`Unknown tool: ${call.name}`))
  }
  if (isStreamingTool(tool)) return runStreaming(tool, call)
  return Stream.fromEffect(
    Tool.execute(tool, call).pipe(
      Effect.catchTag("ToolError", (err) => Effect.succeed(Toolkit.defaultRepair(err, call))),
      Effect.map((output) => ({ _tag: "Output", output }) satisfies ToolEvent),
    ),
  )
}

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
        return Stream.succeed(
          failedEvent(call, tool.name, "Tool input failed schema validation"),
        )
      }

      // Real-time: tap each event into a Ref as it flows; emit one
      // Intermediate per event; concat one synthetic Output element built
      // from the accumulated Ref via `finalize`.
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
                output: Items.functionCallOutput(
                  call.call_id,
                  JSON.stringify(tool.finalize(events as ReadonlyArray<any>)),
                ),
              }) satisfies ToolEvent,
          ),
        ),
      )
      return intermediates.pipe(Stream.concat(output))
    }),
  ).pipe(
    Stream.catchCause(() =>
      Stream.succeed(failedEvent(call, tool.name, "Tool execution failed")),
    ),
  )
