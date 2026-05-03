/**
 * Library: real-time tool execution dispatched by a `Resolver`.
 *
 * `executeWithResolver` is the lowest-level primitive. For each call it
 * asks the resolver for a `ToolDecision`, then:
 *
 *   - Execute        → runs the tool with `call.arguments`
 *   - Reject(output) → emits a single Output event with the
 *                      supplied synthetic `FunctionCallOutput`
 *
 * Streaming and non-streaming tools dispatch identically inside `runOne`
 * via `isStreamingTool`. The resolver knows nothing about whether a tool
 * streams; that's an execution detail.
 *
 * `executeAllSafe` is just `executeWithResolver(tools, calls, () => execute)`.
 */
import { Array as Arr, Effect, Match, Ref, Stream } from "effect";
import * as Items from "@effect-uai/core/Items";
import * as Tool from "@effect-uai/core/Tool";
import * as Toolkit from "@effect-uai/core/Toolkit";
import {
  type AnyKindTool,
  type AnyStreamingTool,
  isStreamingTool,
} from "./StreamingTool.js";
import { type ToolDecision, execute } from "./Outcome.js";
import type { ToolEvent } from "./ToolEvent.js";

export type Resolver = (
  call: Items.FunctionCall,
) => Effect.Effect<ToolDecision>;

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
  );

/** `executeAllSafe` is a degenerate `executeWithResolver` with `Execute` for all. */
export const executeAllSafe = (
  tools: ReadonlyArray<AnyKindTool>,
  calls: ReadonlyArray<Items.FunctionCall>,
): Stream.Stream<ToolEvent> =>
  executeWithResolver(tools, calls, () => Effect.succeed(execute));

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
      Stream.succeed<ToolEvent>({ _tag: "Output", output: d.output }),
    ),
    Match.exhaustive,
  );

// ---------------------------------------------------------------------------
// Per-call execution: streaming vs non-streaming.
// ---------------------------------------------------------------------------

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
});

const runOne = (
  tools: ReadonlyArray<AnyKindTool>,
  call: Items.FunctionCall,
): Stream.Stream<ToolEvent> => {
  const tool = tools.find((t) => t.name === call.name);
  if (tool === undefined) {
    return Stream.fromEffect(Effect.die(`Unknown tool: ${call.name}`));
  }
  if (isStreamingTool(tool)) return runStreaming(tool, call);
  return Stream.fromEffect(
    Tool.execute(tool, call).pipe(
      Effect.catchTag("ToolError", (err) =>
        Effect.succeed(Toolkit.defaultRepair(err, call)),
      ),
      Effect.map((output) => ({ _tag: "Output", output }) satisfies ToolEvent),
    ),
  );
};

const runStreaming = (
  tool: AnyStreamingTool,
  call: Items.FunctionCall,
): Stream.Stream<ToolEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(call.arguments),
        catch: () => "json_parse_error" as const,
      });
      const validated = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
        catch: () => "validation_threw" as const,
      });
      if (validated.issues !== undefined) {
        return Stream.succeed(
          failedEvent(call, tool.name, "Tool input failed schema validation"),
        );
      }

      const ref = yield* Ref.make<ReadonlyArray<unknown>>([]);
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
      );
      const output = Stream.fromEffect(
        Ref.get(ref).pipe(
          Effect.map(
            (events) =>
              ({
                _tag: "Output",
                output: Items.functionCallOutput(
                  call.call_id,
                  JSON.stringify(tool.finalize(events)),
                ),
              }) satisfies ToolEvent,
          ),
        ),
      );
      return intermediates.pipe(Stream.concat(output));
    }),
  ).pipe(
    Stream.catchCause(() =>
      Stream.succeed(failedEvent(call, tool.name, "Tool execution failed")),
    ),
  );
