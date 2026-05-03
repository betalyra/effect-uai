/**
 * Option 5 - `ToolStream` Effect Service injected per-call.
 *
 * Tools that want to emit intermediate events depend on a `ToolStream`
 * service via the env. Existing tools (the 99%) ignore it and don't
 * change.
 *
 * **Two execution paths.** This is the key design point - the queue
 * machinery is opt-in at the executor level, not a per-call tax.
 *
 *   - `executeOne` (default, unchanged signature). Returns
 *     `Effect<FunctionCallOutput>`. Internally provides
 *     `layerNoop` so streaming-aware tools typecheck and their
 *     `publish` calls go to a no-op. **No queue allocated.** Same
 *     machine-code path as today's executor.
 *
 *   - `executeOneStreaming` (opt-in). Returns `Stream<ConsumerEvent>`.
 *     Allocates a per-call queue, provides the publishing layer, drains
 *     the queue alongside the run. Recipes that care about intermediates
 *     use this; everyone else uses `executeOne`.
 *
 * Pros:
 *   - Single Tool type. Tool authors who don't care write `Effect<Output>`.
 *   - Streaming opt-in is type-visible (the tool's `R` includes ToolStream).
 *   - Effect-native: Service + Layer + Queue.
 *   - Framework owns call_id correlation; tool stays ignorant.
 *   - Existing executor path (default) allocates nothing extra. The
 *     no-op layer is a Context entry that's never read for tools that
 *     don't depend on `ToolStream`.
 *
 * Cons:
 *   - One new core concept to learn (`ToolStream` service).
 *   - Two executor paths to maintain. Mirrored on `executeAll` /
 *     `executeAllSafe` / `executeAllSafeStreaming`.
 */
import { Cause, Context, Effect, Layer, Queue, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"

// ---------------------------------------------------------------------------
// The service - tools depend on this when they want to publish progress.
// Mirrors how `LanguageModel` is defined in the core package.
// ---------------------------------------------------------------------------

interface ToolStreamShape {
  readonly publish: (data: unknown) => Effect.Effect<void>
}

export class ToolStream extends Context.Service<ToolStream, ToolStreamShape>()(
  "@effect-uai/spike/ToolStream",
) {}

/**
 * No-op layer. Provided by the default `executeOne` so streaming-aware
 * tools typecheck and run without their publishes hitting any queue.
 * Tools that don't depend on `ToolStream` never look it up; this layer
 * costs them nothing.
 */
export const layerNoop: Layer.Layer<ToolStream> = Layer.succeed(ToolStream, {
  publish: () => Effect.void,
})

/** Build a layer that publishes into a queue, tagging events with `call_id`. */
const layerToQueueAs = (
  queue: Queue.Queue<ConsumerEvent, Cause.Done>,
  call_id: string,
): Layer.Layer<ToolStream> =>
  Layer.succeed(ToolStream, {
    publish: (data) =>
      Queue.offer(queue, { _tag: "Intermediate", call_id, data }).pipe(Effect.asVoid),
  })

// ---------------------------------------------------------------------------
// Toy tools.
// ---------------------------------------------------------------------------

const ThinkerInput = Schema.Struct({ question: Schema.String })

/**
 * Streaming-aware tool. `R = ToolStream`. Runs in either executor path:
 * in `executeOne` the publishes go to the no-op; in `executeOneStreaming`
 * they're routed through the queue.
 */
export const thinker = Tool.make({
  name: "thinker",
  description: "Think step by step and answer.",
  inputSchema: Tool.fromEffectSchema(ThinkerInput),
  run: ({ question }) =>
    Effect.gen(function* () {
      const stream = yield* ToolStream
      yield* stream.publish({ thought: "considering..." })
      yield* stream.publish({ thought: "almost there..." })
      yield* stream.publish({ thought: "finalizing..." })
      return { answer: `The answer to "${question}" is 42.` }
    }),
  strict: true,
})

/** Non-streaming tool - the 99% case, untouched. R = never. */
const EchoInput = Schema.Struct({ text: Schema.String })

export const echo = Tool.make({
  name: "echo",
  description: "Echo the input.",
  inputSchema: Tool.fromEffectSchema(EchoInput),
  run: ({ text }) => Effect.succeed({ echoed: text }),
  strict: true,
})

// ---------------------------------------------------------------------------
// Executor - default path. Same shape as today's `executeOne`.
// No queue, no extra fibers, no streaming machinery. The no-op layer
// just satisfies the `ToolStream` requirement for streaming-aware tools
// so they can run anywhere; non-streaming tools never reference it.
// ---------------------------------------------------------------------------

export const executeOne = <Input, Output, R>(
  tool: Tool.Tool<string, Input, Output, R>,
  call: Items.FunctionCall,
): Effect.Effect<Items.FunctionCallOutput, Tool.ToolError, Exclude<R, ToolStream>> =>
  Tool.execute(tool, call).pipe(Effect.provide(layerNoop)) as Effect.Effect<
    Items.FunctionCallOutput,
    Tool.ToolError,
    Exclude<R, ToolStream>
  >

// ---------------------------------------------------------------------------
// Executor - streaming path. Allocates a per-call queue, routes publishes,
// emits intermediates followed by the terminal Output.
// ---------------------------------------------------------------------------

export type ConsumerEvent =
  | { readonly _tag: "Intermediate"; readonly call_id: string; readonly data: unknown }
  | { readonly _tag: "Output"; readonly output: Items.FunctionCallOutput }

export const executeOneStreaming = <Input, Output>(
  tool: Tool.Tool<string, Input, Output, ToolStream>,
  call: Items.FunctionCall,
): Stream.Stream<ConsumerEvent, unknown> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // `Cause.Done` lets us `Queue.end` to signal EOF without dropping
      // buffered items (Queue.shutdown is the abrupt variant).
      const queue = yield* Queue.unbounded<ConsumerEvent, Cause.Done>()

      // Driver: run the tool (ToolStream layer publishes intermediates
      // into the queue), then offer the terminal Output, then end.
      const driver = Tool.execute(tool, call).pipe(
        Effect.provide(layerToQueueAs(queue, call.call_id)),
        Effect.flatMap((output) =>
          Queue.offer(queue, { _tag: "Output", output }).pipe(
            Effect.flatMap(() => Queue.end(queue)),
          ),
        ),
      )

      // Stream.drainFork runs the driver as a side fiber while we emit
      // queue elements. Order is preserved (single queue, FIFO) and
      // the driver's lifetime is tied to the stream's, not a gen scope.
      return Stream.fromQueue(queue).pipe(Stream.drainFork(Stream.fromEffect(driver)))
    }),
  )

// ---------------------------------------------------------------------------
// Mixed-toolkit streaming - the answer to "what if my turn has both
// streaming and non-streaming tools?"
//
// One queue per TURN (not per call). Each call gets its own per-call
// layer that tags publishes with the right call_id. Non-streaming
// tools never reference the layer, never touch the queue. Streaming
// tools publish into the shared queue. Every tool's terminal Output
// is enqueued by the driver after its run resolves.
// ---------------------------------------------------------------------------

type AnyToolkit = ReadonlyArray<{
  readonly name: string
  readonly run: (input: never) => Effect.Effect<unknown, unknown, ToolStream>
  readonly inputSchema: Tool.ToolInputSchema<never>
  readonly strict?: boolean
  readonly description: string
}>

export const executeAllSafeStreaming = (
  toolkit: AnyToolkit,
  calls: ReadonlyArray<Items.FunctionCall>,
): Stream.Stream<ConsumerEvent, never> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ConsumerEvent, Cause.Done>()

      // Build one driver per call: provide a per-call publishing layer
      // tagged with this call's id, run the tool, enqueue the terminal
      // Output. Non-streaming tools never look up ToolStream - the
      // layer is just dead context for them.
      const drivers = calls.map((call) => {
        const tool = toolkit.find((t) => t.name === call.name)
        if (tool === undefined) return Effect.die(`Unknown tool: ${call.name}`)
        const run = Tool.execute(
          tool as unknown as Tool.Tool<string, unknown, unknown, ToolStream>,
          call,
        ).pipe(
          Effect.provide(layerToQueueAs(queue, call.call_id)),
          // Tool errors → structured FunctionCallOutput so the loop sees
          // a well-formed history. Mirror executeAllSafe's `defaultRepair`.
          Effect.catchTag("ToolError", (err) =>
            Effect.succeed(
              Items.functionCallOutput(
                call.call_id,
                JSON.stringify({
                  kind: "execution_error",
                  tool: err.tool,
                  message: err.message,
                }),
              ),
            ),
          ),
          Effect.flatMap((output) => Queue.offer(queue, { _tag: "Output", output })),
        )
        return run
      })

      // Run all drivers concurrently. When the last one finishes, end
      // the queue so the consumer sees EOF.
      const turnDriver = Effect.forEach(drivers, (d) => d, {
        concurrency: "unbounded",
      }).pipe(Effect.flatMap(() => Queue.end(queue)))

      return Stream.fromQueue(queue).pipe(Stream.drainFork(Stream.fromEffect(turnDriver)))
    }),
  )
