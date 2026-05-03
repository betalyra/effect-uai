/**
 * Option 7 - Closure capture (revised).
 *
 * The simplest possible approach: tools are written (or made by a
 * factory) such that their `run` closures capture a queue from the
 * enclosing scope. The loop body creates the queue per turn, builds
 * the toolkit with the queue closed-over, runs `executeAllSafe`, ends
 * the queue, and concats the queue's drained stream with the outputs.
 *
 * **Zero changes to `Tool`, `Toolkit`, `Tool.run` signatures, or
 * `executeAllSafe`.** No new Service. No new Layer. No new option
 * object. Just JavaScript closures and the queue type the recipe
 * author chooses.
 *
 * Pros:
 *   - Smallest possible footprint - nothing new in core.
 *   - Tool author has full control over event types (whatever they
 *     push to the queue is what the recipe sees).
 *   - Mixed-tool turns work automatically: non-streaming tools never
 *     reference the queue.
 *   - Per-turn queue lifecycle is explicit and easy to reason about.
 *
 * Cons:
 *   - **Buffered, not real-time.** The body's `yield*` parks on
 *     `executeAllSafe`; the consumer sees nothing during tool
 *     execution. When `executeAllSafe` resolves, the queue is fully
 *     populated, and the consumer receives intermediates and outputs
 *     together. Fine for batch / audit / test scenarios; not for
 *     live UI updates of long-running tools.
 *   - Tool author must take care: the `run` of a streaming-aware tool
 *     is closed over a specific queue, so the tool must be created
 *     inside the loop body OR via a factory that receives the queue.
 *   - No framework-imposed correlation by `call_id`. The tool tags
 *     events with whatever it knows (its own name); finer correlation
 *     requires the recipe to define richer event payloads.
 *
 * For the real-time variant see `option-7-realtime.ts` (TODO if we
 * decide we need it - uses `Stream.drainFork` plus a `nextAfterCollect`
 * helper to emit intermediates as they arrive).
 */
import { Cause, Effect, Queue, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"

// ---------------------------------------------------------------------------
// Event types - defined by the recipe, not the framework. Whatever shape
// the tools and the recipe agree on.
// ---------------------------------------------------------------------------

export interface ThinkerEvent {
  readonly tool: "thinker"
  readonly thought: string
}

// ---------------------------------------------------------------------------
// Streaming-aware tool, written as a factory that captures a queue.
// ---------------------------------------------------------------------------

const ThinkerInput = Schema.Struct({ question: Schema.String })

export const makeThinker = (queue: Queue.Enqueue<ThinkerEvent>) =>
  Tool.make({
    name: "thinker",
    description: "Think step by step and answer.",
    inputSchema: Tool.fromEffectSchema(ThinkerInput),
    run: ({ question }) =>
      Effect.gen(function* () {
        yield* Queue.offer(queue, { tool: "thinker", thought: "considering..." })
        yield* Queue.offer(queue, { tool: "thinker", thought: "almost there..." })
        yield* Queue.offer(queue, { tool: "thinker", thought: "finalizing..." })
        return { answer: `The answer to "${question}" is 42.` }
      }),
    strict: true,
  })

// ---------------------------------------------------------------------------
// Non-streaming tool, defined at module level. Doesn't reference any queue.
// ---------------------------------------------------------------------------

const EchoInput = Schema.Struct({ text: Schema.String })

export const echo = Tool.make({
  name: "echo",
  description: "Echo the input.",
  inputSchema: Tool.fromEffectSchema(EchoInput),
  run: ({ text }) => Effect.succeed({ echoed: text }),
  strict: true,
})

// ---------------------------------------------------------------------------
// Recipe-shape helper - what a streaming-tool-aware loop body looks like.
//
// Returns a Stream<ThinkerEvent | FunctionCallOutput>. Recipe author
// would compose this with the rest of the loop body via `nextAfter`
// using the `outputs` array (read from the resolved `executeAllSafe`).
// ---------------------------------------------------------------------------

export interface TurnResult {
  readonly events: Stream.Stream<ThinkerEvent | Items.FunctionCallOutput>
  readonly outputs: ReadonlyArray<Items.FunctionCallOutput>
}

/**
 * Run a turn against a fresh per-turn queue + toolkit. Returns the events
 * stream (intermediates then outputs, in arrival order) AND the outputs
 * array (for the recipe to thread into next state).
 *
 * The events are buffered: by the time this Effect resolves, the queue
 * has been drained into the stream and the stream is fully realized.
 */
export const runTurn = (
  calls: ReadonlyArray<Items.FunctionCall>,
): Effect.Effect<TurnResult> =>
  Effect.gen(function* () {
    // Per-turn queue. Lives entirely inside this function's scope.
    const queue = yield* Queue.unbounded<ThinkerEvent, Cause.Done>()

    // Build the toolkit with the queue captured in `makeThinker`'s closure.
    // `echo` is module-level; queue is irrelevant to it.
    const toolkit = Toolkit.make([makeThinker(queue), echo])

    // Run all tools to completion. By the time this resolves, every push
    // to `queue` has happened.
    const outputs = yield* Toolkit.executeAllSafe(toolkit, calls)

    // Signal end-of-events so `Stream.fromQueue` terminates instead of
    // blocking forever.
    yield* Queue.end(queue)

    // Concat: queued intermediates first (drained from a now-finite queue),
    // then outputs in source order. This is the stream the loop body would
    // pass into `nextAfter(events, { ...next, history: [..., ...outputs] })`.
    const events: Stream.Stream<ThinkerEvent | Items.FunctionCallOutput> = Stream.concat(
      Stream.fromQueue(queue),
      Stream.fromIterable(outputs),
    )

    return { events, outputs }
  })
