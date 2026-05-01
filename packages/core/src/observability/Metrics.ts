import { Clock, Duration, Effect, Option, Stream } from "effect"

/**
 * Annotate every event in a stream with the elapsed `Duration` since the
 * stream started consuming. The first event reports its time-from-start,
 * which is also the conventional "time to first ____" metric.
 */
export const withElapsed = <A, E, R>(
  self: Stream.Stream<A, E, R>,
): Stream.Stream<{ readonly value: A; readonly elapsed: Duration.Duration }, E, R> =>
  Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (start) =>
      self.pipe(
        Stream.mapEffect((value) =>
          Effect.map(Clock.currentTimeMillis, (now) => ({
            value,
            elapsed: Duration.millis(now - start),
          })),
        ),
      ),
    ),
  )

/**
 * Compute the elapsed time until the first event matching the predicate.
 * Returns `Option.none()` if the stream completes without one.
 *
 * Consumes the stream. To track this *alongside* live consumption, use
 * `Stream.broadcast` to fan the source out and run `timeToFirst` on one
 * branch.
 */
export const timeToFirst =
  <A>(predicate: (a: A) => boolean) =>
  <E, R>(self: Stream.Stream<A, E, R>): Effect.Effect<Option.Option<Duration.Duration>, E, R> =>
    withElapsed(self).pipe(
      Stream.filter(({ value }) => predicate(value)),
      Stream.runHead,
      Effect.map(Option.map(({ elapsed }) => elapsed)),
    )

export interface RatePoint<A> {
  readonly value: A
  readonly total: number
  readonly ratePerSecond: number
  readonly elapsed: Duration.Duration
}

/**
 * Annotate every event with a running total and a rolling rate per second,
 * computed from a user-supplied weight function.
 *
 * The weight is the unit you care about - bytes, tokens, error count, etc.
 * For tokens-per-second on `TurnEvent`, pass:
 *
 *   `(d) => d.type === "text_delta" ? countTokens(d.text) : 0`
 *
 * Use any tokenizer you like; the library does not ship one.
 */
export const withRate =
  <A>(weight: (a: A) => number) =>
  <E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<RatePoint<A>, E, R> =>
    Stream.unwrap(
      Effect.map(Clock.currentTimeMillis, (start) =>
        self.pipe(
          Stream.mapAccumEffect(
            () => ({ total: 0 }),
            (acc, value) =>
              Effect.map(Clock.currentTimeMillis, (now) => {
                const total = acc.total + weight(value)
                const elapsedMs = now - start
                const ratePerSecond = elapsedMs > 0 ? (total / elapsedMs) * 1000 : 0
                return [
                  { total },
                  [
                    {
                      value,
                      total,
                      ratePerSecond,
                      elapsed: Duration.millis(elapsedMs),
                    } satisfies RatePoint<A>,
                  ],
                ] as const
              }),
          ),
        ),
      ),
    )
