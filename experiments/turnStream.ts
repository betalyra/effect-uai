import { Effect, Option, Ref, Stream } from "effect"
import type { Turn, TurnDelta } from "../src/Turn.js"
import { isTurnComplete } from "../src/Turn.js"

type NonTerminalTurnDelta = Exclude<TurnDelta, { readonly type: "turn_complete" }>

interface StreamUntilCompleteOptions<A, E, R, E2, R2> {
  readonly emit: (delta: NonTerminalTurnDelta) => Stream.Stream<A, E2, R2>
  readonly then: (turn: Turn) => Effect.Effect<Stream.Stream<A, E2, R2>, E2, R2>
  readonly onMissing?: Effect.Effect<Stream.Stream<A, E2, R2>, E2, R2>
}

/**
 * Stream non-terminal turn deltas as user-facing events, then continue with
 * the completed `Turn`. This is the streaming counterpart to
 * `Turn.untilTurnComplete`: callers still own the loop, tools, and state.
 */
export const streamUntilComplete = <A, E, R, E2 = never, R2 = never>(
  deltas: Stream.Stream<TurnDelta, E, R>,
  options: StreamUntilCompleteOptions<A, E, R, E2, R2>,
): Stream.Stream<A, E | E2, R | R2> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const turnRef = yield* Ref.make<Option.Option<Turn>>(Option.none())

      const events = deltas.pipe(
        Stream.takeUntil(isTurnComplete),
        Stream.tap((delta) =>
          isTurnComplete(delta) ? Ref.set(turnRef, Option.some(delta.turn)) : Effect.void,
        ),
        Stream.flatMap((delta) =>
          isTurnComplete(delta) ? Stream.empty : options.emit(delta),
        ),
      )

      const continuation = Stream.unwrap(
        Ref.get(turnRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => options.onMissing ?? Effect.succeed(Stream.empty),
              onSome: options.then,
            }),
          ),
        ),
      )

      return Stream.concat(events, continuation)
    }),
  )
