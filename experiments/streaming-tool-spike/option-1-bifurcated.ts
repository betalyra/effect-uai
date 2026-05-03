/**
 * Option 1 - Bifurcated Tool type.
 *
 * A new constructor `Tool.streaming` produces a distinct `StreamingTool`.
 * Existing `Tool.make` is unchanged. The toolkit holds a heterogeneous
 * mix; the executor branches on tool kind. Tool authors pick at
 * definition time which shape they want.
 *
 * Pros:
 *   - Type-safe at definition; no optional runtime detection.
 *   - Existing tools 100% unchanged.
 *   - Clear separation of "this tool emits progress" from
 *     "this tool just returns a value."
 *
 * Cons:
 *   - Two Tool variants, two execution paths.
 *   - A streaming tool that needs to upgrade to "actually I want to
 *     return a single value" requires changing constructor.
 *   - Sub-agents that sometimes stream and sometimes don't need an
 *     awkward branch at definition time.
 */
import { Effect, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"

// ---------------------------------------------------------------------------
// New types
// ---------------------------------------------------------------------------

/**
 * What a streaming tool emits per element. All-but-last events are
 * `Intermediate` (free `data: unknown`, tool author defines shape).
 * The terminal `Result` carries the value the model will see on its
 * next turn (becomes the `FunctionCallOutput`).
 */
export type StreamingToolEvent<Output> =
  | { readonly _tag: "Intermediate"; readonly data: unknown }
  | { readonly _tag: "Result"; readonly output: Output }

export interface StreamingTool<Name extends string, Input, Output, R = never> {
  readonly _kind: "streaming"
  readonly name: Name
  readonly description: string
  readonly inputSchema: Tool.ToolInputSchema<Input>
  readonly run: (input: Input) => Stream.Stream<StreamingToolEvent<Output>, unknown, R>
  readonly strict?: boolean
}

export const streaming = <Name extends string, Input, Output, R = never>(
  spec: Omit<StreamingTool<Name, Input, Output, R>, "_kind">,
): StreamingTool<Name, Input, Output, R> => ({ _kind: "streaming", ...spec })

// ---------------------------------------------------------------------------
// Toy tool - a "thinker" that emits 3 intermediate thoughts then answers.
// ---------------------------------------------------------------------------

const ThinkerInput = Schema.Struct({ question: Schema.String })

export const thinker = streaming({
  name: "thinker",
  description: "Think step by step and answer.",
  inputSchema: Tool.fromEffectSchema(ThinkerInput),
  run: ({ question }) =>
    Stream.fromIterable<StreamingToolEvent<{ answer: string }>>([
      { _tag: "Intermediate", data: { thought: "considering..." } },
      { _tag: "Intermediate", data: { thought: "almost there..." } },
      { _tag: "Intermediate", data: { thought: "finalizing..." } },
      { _tag: "Result", output: { answer: `The answer to "${question}" is 42.` } },
    ]),
  strict: true,
})

// ---------------------------------------------------------------------------
// Executor - what the loop body would call instead of `executeOne`.
// Returns a Stream<ConsumerEvent> where the terminal carries the
// `FunctionCallOutput` the loop will append to history.
// ---------------------------------------------------------------------------

export type ConsumerEvent =
  | { readonly _tag: "Intermediate"; readonly call_id: string; readonly data: unknown }
  | { readonly _tag: "Output"; readonly output: Items.FunctionCallOutput }

export const execute = <Input, Output, R>(
  tool: StreamingTool<string, Input, Output, R>,
  call: Items.FunctionCall,
): Stream.Stream<ConsumerEvent, unknown, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Validate args against the tool's schema (same as Tool.execute does).
      const parsed = JSON.parse(call.arguments) as unknown
      const validated = yield* Effect.promise(() =>
        Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
      )
      if (validated.issues !== undefined) {
        // For brevity the spike skips structured ValidationFailed output.
        return Stream.fail(new Error("Validation failed"))
      }
      return tool.run(validated.value).pipe(
        Stream.map((event): ConsumerEvent =>
          event._tag === "Result"
            ? {
                _tag: "Output",
                output: Items.functionCallOutput(call.call_id, JSON.stringify(event.output)),
              }
            : { _tag: "Intermediate", call_id: call.call_id, data: event.data },
        ),
      )
    }),
  )
