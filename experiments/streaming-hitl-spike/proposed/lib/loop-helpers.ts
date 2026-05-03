/**
 * Library: bridges between a `Stream<A>` and the loop's emit shape.
 *
 *   - `nextAfterFold` is the general primitive: drain a stream to the
 *     consumer, fold elements into an accumulator, emit one
 *     `Loop.next(build(finalAcc))` at end-of-stream. Subsumes
 *     `Loop.nextAfter` (state constant, ignore elements).
 *
 *   - `nextStateFrom` is the streaming-tool specialization: collects every
 *     `ToolEvent.Output`'s `ToolResult` into an array and hands it to
 *     `build` for state construction. The recipe is responsible for
 *     converting results to `FunctionCallOutput`s when threading into
 *     history (one explicit `.map(toFunctionCallOutput)`).
 *
 * In the framework `nextAfterFold` would extend `@effect-uai/core/Loop`
 * and `nextStateFrom` would live alongside the executor.
 */
import { Array as Arr, Effect, Ref, Stream } from "effect"
import * as Loop from "@effect-uai/core/Loop"
import type { ToolResult } from "./Outcome.js"
import { isOutput, type ToolEvent } from "./ToolEvent.js"

export const nextAfterFold = <A, B, S, E, R>(
  stream: Stream.Stream<A, E, R>,
  initial: B,
  reduce: (acc: B, a: A) => B,
  build: (b: B) => S,
): Stream.Stream<Loop.Event<A, S>, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      const tapped = stream.pipe(
        Stream.tap((a) => Ref.update(ref, (acc) => reduce(acc, a))),
        Stream.map(Loop.value),
      )
      const continuation = Stream.fromEffect(
        Ref.get(ref).pipe(Effect.map((acc) => Loop.next(build(acc)))),
      )
      return tapped.pipe(Stream.concat(continuation))
    }),
  )

export const nextStateFrom = <S>(
  stream: Stream.Stream<ToolEvent>,
  build: (results: ReadonlyArray<ToolResult>) => S,
): Stream.Stream<Loop.Event<ToolEvent, S>> =>
  nextAfterFold(
    stream,
    [] as ReadonlyArray<ToolResult>,
    (acc, e) => (isOutput(e) ? Arr.append(acc, e.result) : acc),
    build,
  )
