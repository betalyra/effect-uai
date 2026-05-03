/**
 * Option 6 - Tool's `run` takes an optional second argument with a
 * `publish` function.
 *
 * The Tool type widens: `run: (input, ctx?) => Effect<Output>`. Tools
 * that ignore `ctx` work as before (its absence at the call site is
 * type-safe via optional). Tools that want to emit intermediate events
 * call `ctx.publish(data)`.
 *
 * Pros:
 *   - No new Service/Layer abstraction. Just a function arg.
 *   - Tool author sees the affordance directly in their `run` signature.
 *   - Existing tools that don't reference `ctx` work unchanged.
 *
 * Cons:
 *   - The Tool type's `run` signature gains a parameter. Existing
 *     definitions that wrote `run: (input) => ...` continue to work
 *     because the second arg is unused, but the *type* of `Tool.make`
 *     widens, which can ripple into dependent type definitions.
 *   - Less testable than Option 5 - tool authors who use `ctx.publish`
 *     can be tested by passing a fake ctx, but it's not Layer-swappable
 *     across the whole toolkit.
 *   - Smells slightly OOP (object-with-methods-as-arg).
 */
import { Cause, Effect, Queue, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"

// ---------------------------------------------------------------------------
// The context object passed as the second arg.
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Publish an intermediate event for this call. */
  readonly publish: (data: unknown) => Effect.Effect<void>
}

// A no-op ctx for places that don't care (and for typing tests).
export const noopCtx: ToolContext = { publish: () => Effect.void }

// ---------------------------------------------------------------------------
// Local widened Tool type for the spike. Real version would update
// `Tool.Tool` to make `run` accept the optional ctx.
// ---------------------------------------------------------------------------

export interface CtxTool<Name extends string, Input, Output, R = never> {
  readonly name: Name
  readonly description: string
  readonly inputSchema: Tool.ToolInputSchema<Input>
  readonly run: (input: Input, ctx?: ToolContext) => Effect.Effect<Output, unknown, R>
  readonly strict?: boolean
}

export const make = <Name extends string, Input, Output, R = never>(
  spec: CtxTool<Name, Input, Output, R>,
): CtxTool<Name, Input, Output, R> => spec

// ---------------------------------------------------------------------------
// Toy tool - publishes via ctx.
// ---------------------------------------------------------------------------

const ThinkerInput = Schema.Struct({ question: Schema.String })

export const thinker = make({
  name: "thinker",
  description: "Think step by step and answer.",
  inputSchema: Tool.fromEffectSchema(ThinkerInput),
  run: ({ question }, ctx = noopCtx) =>
    Effect.gen(function* () {
      yield* ctx.publish({ thought: "considering..." })
      yield* ctx.publish({ thought: "almost there..." })
      yield* ctx.publish({ thought: "finalizing..." })
      return { answer: `The answer to "${question}" is 42.` }
    }),
  strict: true,
})

// Non-streaming tool - never references the second arg, type-safe.
const EchoInput = Schema.Struct({ text: Schema.String })

export const echo = make({
  name: "echo",
  description: "Echo the input.",
  inputSchema: Tool.fromEffectSchema(EchoInput),
  run: ({ text }) => Effect.succeed({ echoed: text }),
  strict: true,
})

// ---------------------------------------------------------------------------
// Executor.
// ---------------------------------------------------------------------------

export type ConsumerEvent =
  | { readonly _tag: "Intermediate"; readonly call_id: string; readonly data: unknown }
  | { readonly _tag: "Output"; readonly output: Items.FunctionCallOutput }

export const execute = <Input, Output>(
  tool: CtxTool<string, Input, Output, never>,
  call: Items.FunctionCall,
): Stream.Stream<ConsumerEvent, unknown> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ConsumerEvent, Cause.Done>()
      const ctx: ToolContext = {
        publish: (data) =>
          Queue.offer(queue, {
            _tag: "Intermediate",
            call_id: call.call_id,
            data,
          }).pipe(Effect.asVoid),
      }

      // Validate input (mirrors what Tool.execute does internally).
      const parsed = JSON.parse(call.arguments) as unknown
      const validated = yield* Effect.promise(() =>
        Promise.resolve(tool.inputSchema["~standard"].validate(parsed)),
      )
      if (validated.issues !== undefined) {
        return Stream.fail(new Error("Validation failed"))
      }

      // Driver: run the tool (which publishes via ctx.publish), then
      // offer the Output and end the queue.
      const driver = tool.run(validated.value, ctx).pipe(
        Effect.flatMap((output) =>
          Queue.offer(queue, {
            _tag: "Output",
            output: Items.functionCallOutput(call.call_id, JSON.stringify(output)),
          }).pipe(Effect.flatMap(() => Queue.end(queue))),
        ),
      )

      return Stream.fromQueue(queue).pipe(Stream.drainFork(Stream.fromEffect(driver)))
    }),
  )
