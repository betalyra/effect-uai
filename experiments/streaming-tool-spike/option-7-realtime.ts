/**
 * Option 7 - real-time variant.
 *
 * Same closure-capture pattern as `option-7-shared-queue.ts`, but using
 * `Stream.drainFork` so the consumer sees intermediates **as they
 * happen** rather than buffered until `executeAllSafe` resolves.
 *
 * Zero changes to `Tool`, `Toolkit`, `Tool.run`, or `executeAllSafe`.
 * The only difference vs the buffered version is the driver runs as a
 * forked side fiber tied to the stream's scope, so emission and tool
 * execution are concurrent.
 *
 * Cost over the buffered version:
 *   - Recipe author's `runTurn` is a single `Stream` instead of a
 *     `{ events, outputs }` pair, because the outputs only become known
 *     mid-stream (when the driver enqueues them after `executeAllSafe`).
 *     Recipe extracts outputs by tapping `{_tag: "Output"}` events as
 *     they flow through.
 *   - Real-time correctness is sensitive to scope: cancelling the
 *     stream early interrupts the driver mid-tool. That's the right
 *     behavior; just be deliberate about it.
 *
 * The slow-thinker tool used here has `Effect.sleep` between thoughts
 * so the test can observe the real-time-ness deterministically.
 */
import { Cause, Duration, Effect, Queue, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"

// ---------------------------------------------------------------------------
// Event types - same as the buffered version. The realtime stream
// carries `ThinkerEvent | FunctionCallOutput` in arrival order.
// ---------------------------------------------------------------------------

export interface ThinkerEvent {
  readonly tool: "thinker"
  readonly thought: string
}

// ---------------------------------------------------------------------------
// Slow thinker - sleeps between thoughts so the test can verify that
// intermediates arrive while the tool is still running (not buffered).
// ---------------------------------------------------------------------------

const ThinkerInput = Schema.Struct({ question: Schema.String })

export const makeSlowThinker = (
  queue: Queue.Enqueue<ThinkerEvent>,
  delay: Duration.Input,
) =>
  Tool.make({
    name: "thinker",
    description: "Think step by step, slowly.",
    inputSchema: Tool.fromEffectSchema(ThinkerInput),
    run: ({ question }) =>
      Effect.gen(function* () {
        yield* Queue.offer(queue, { tool: "thinker", thought: "considering..." })
        yield* Effect.sleep(delay)
        yield* Queue.offer(queue, { tool: "thinker", thought: "almost there..." })
        yield* Effect.sleep(delay)
        yield* Queue.offer(queue, { tool: "thinker", thought: "finalizing..." })
        yield* Effect.sleep(delay)
        return { answer: `The answer to "${question}" is 42.` }
      }),
    strict: true,
  })

const EchoInput = Schema.Struct({ text: Schema.String })

export const echo = Tool.make({
  name: "echo",
  description: "Echo the input.",
  inputSchema: Tool.fromEffectSchema(EchoInput),
  run: ({ text }) => Effect.succeed({ echoed: text }),
  strict: true,
})

// ---------------------------------------------------------------------------
// Real-time turn execution.
//
// Single queue carries both intermediates and the terminal Outputs.
// `Stream.drainFork` runs the driver (executeAllSafe + offer outputs +
// end queue) as a side fiber while the main stream pulls from the queue.
// ---------------------------------------------------------------------------

export const runTurnRealtime = (
  calls: ReadonlyArray<Items.FunctionCall>,
  options?: { readonly delay?: Duration.Input },
): Stream.Stream<ThinkerEvent | Items.FunctionCallOutput> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<
        ThinkerEvent | Items.FunctionCallOutput,
        Cause.Done
      >()

      // Toolkit built per turn with the queue closed-over by `makeSlowThinker`.
      const toolkit = Toolkit.make([
        makeSlowThinker(queue, options?.delay ?? "50 millis"),
        echo,
      ])

      // Driver: run all tools (intermediates flow into the queue as they
      // happen), then offer each FunctionCallOutput into the same queue,
      // then end the queue so the consumer's stream terminates.
      const driver = Toolkit.executeAllSafe(toolkit, calls).pipe(
        Effect.flatMap((outputs) =>
          Effect.forEach(outputs, (o) => Queue.offer(queue, o)).pipe(
            Effect.flatMap(() => Queue.end(queue)),
          ),
        ),
      )

      // The key line: drainFork attaches the driver as a side fiber to
      // the stream's scope. The stream emits queue elements as they
      // arrive - real-time. If the consumer stops pulling early, the
      // driver is interrupted (correct behavior).
      return Stream.fromQueue(queue).pipe(Stream.drainFork(Stream.fromEffect(driver)))
    }),
  )
