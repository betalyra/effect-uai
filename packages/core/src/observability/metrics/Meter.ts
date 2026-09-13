/**
 * The plumbing every latency meter is built from, with no knowledge of any
 * capability's events.
 *
 * A meter is one shape: a boundary that ends a segment (a turn, a response, an
 * utterance), an anchor the clock starts at, and a predicate it stops on. The
 * presets in `Turn` and `Realtime` are these operators plus predicates, and a
 * custom meter is the same thing written by hand.
 */
import { Clock, Data, Duration, Effect, Option, Ref, Stream } from "effect"
import { type MetricEvent } from "./MetricEvent.js"

/** Where a caller writes the instant a meter should measure from. */
export type MarkRef = Ref.Ref<Option.Option<number>>

/** A `Ref` for `Anchor.Mark`, empty until the first `mark`. */
export const markRef: Effect.Effect<MarkRef> = Ref.make(Option.none<number>())

/** Stamp the current time, for a meter anchored on `Anchor.Mark(ref)`. */
export const mark = (ref: MarkRef): Effect.Effect<void> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(ref, Option.some(now)))

/**
 * Where a segment's clock starts.
 *
 * - `Request`: stream initialization, so the first segment measures from when
 *   the request fired and each later one from the previous boundary.
 * - `FirstEvent`: the segment's own first element, excluding whatever the
 *   caller waited through before the stream produced anything.
 * - `Element`: the most recent element `matches` accepted. A segment that
 *   never sees one reports nothing.
 * - `Mark`: an instant the caller stamped, for a start the measured stream
 *   cannot see. Each mark is spent once, so a segment reports nothing until
 *   `mark` is called again.
 */
export type Anchor = Data.TaggedEnum<{
  Request: {}
  FirstEvent: {}
  Element: { readonly matches: (ev: unknown) => boolean }
  Mark: { readonly ref: MarkRef }
}>

export const Anchor = Data.taggedEnum<Anchor>()

type Start = Option.Option<number>

/** An anchor reduced to the two things a segment meter asks of it. */
type Clockwork = {
  /** The start of a fresh segment, at stream init and at every boundary. */
  readonly opening: (at: number) => Start
  /** Where the start stands once this element has been seen. */
  readonly advance: (start: Start, ev: unknown, now: number) => Effect.Effect<Start>
}

const pure = (start: Start): Effect.Effect<Start> => Effect.succeed(start)

const clockwork = (anchor: Anchor): Clockwork =>
  Anchor.$match(anchor, {
    Request: (): Clockwork => ({ opening: Option.some, advance: (start) => pure(start) }),
    FirstEvent: (): Clockwork => ({
      opening: Option.none,
      advance: (start, _ev, now) => pure(Option.isNone(start) ? Option.some(now) : start),
    }),
    Element: ({ matches }): Clockwork => ({
      opening: Option.none,
      advance: (start, ev, now) => pure(matches(ev) ? Option.some(now) : start),
    }),
    // The mark lives outside the stream, so a boundary cannot clear it. The
    // spent value in `FirstState` is what keeps it from timing a second segment.
    Mark: ({ ref }): Clockwork => ({ opening: () => Option.none(), advance: () => Ref.get(ref) }),
  })

export type FirstSample<F> = {
  /** What `first` carried out of the element that stopped the clock. */
  readonly match: F
  readonly elapsed: Duration.Duration
  readonly segmentIndex: number
}

export type TimeToFirstOptions<F> = {
  readonly anchor: Anchor
  /** Stops the clock, and hands its payload to `event`. */
  readonly first: (ev: unknown) => Option.Option<F>
  /** Ends the segment: the next element belongs to the following one. */
  readonly boundary: (ev: unknown) => boolean
  readonly event: (sample: FirstSample<F>) => MetricEvent
}

type FirstState = {
  readonly segmentIndex: number
  readonly start: Start
  readonly seen: boolean
  /** The anchor a sample was already measured from, never measured from twice. */
  readonly spent: Start
}

/** Whether this exact anchor already produced a sample. */
const spentAlready = (state: FirstState, start: Option.Option<number>): boolean =>
  Option.isSome(state.spent) && Option.isSome(start) && state.spent.value === start.value

/** Elapsed from the anchor to the first matching element, once per segment. */
export const timeToFirst =
  <F>(options: TimeToFirstOptions<F>) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A | MetricEvent, E, R> => {
    const { advance, opening } = clockwork(options.anchor)

    return Stream.unwrap(
      Effect.map(Clock.currentTimeMillis, (init) =>
        self.pipe(
          Stream.mapAccumEffect(
            (): FirstState => ({
              segmentIndex: 0,
              start: opening(init),
              seen: false,
              spent: Option.none(),
            }),
            (state, ev) =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                const start = yield* advance(state.start, ev, now)
                // One shot per segment: a match with no anchor spends it too,
                // rather than letting a later anchor time the wrong element.
                const match = state.seen ? Option.none<F>() : options.first(ev)
                const sample =
                  Option.isSome(match) && Option.isSome(start) && !spentAlready(state, start)
                    ? Option.some(
                        options.event({
                          match: match.value,
                          elapsed: Duration.millis(now - start.value),
                          segmentIndex: state.segmentIndex,
                        }),
                      )
                    : Option.none<MetricEvent>()
                const out: ReadonlyArray<A | MetricEvent> = Option.isSome(sample)
                  ? [ev, sample.value]
                  : [ev]
                const spent = Option.isSome(sample) ? start : state.spent
                const next: FirstState = options.boundary(ev)
                  ? {
                      segmentIndex: state.segmentIndex + 1,
                      start: opening(now),
                      seen: false,
                      spent,
                    }
                  : { ...state, start, seen: state.seen || Option.isSome(match), spent }
                return [next, out] as const
              }),
          ),
        ),
      ),
    )
  }

export type DurationSample = {
  readonly duration: Duration.Duration
  readonly generation: Duration.Duration
  readonly segmentIndex: number
}

export type SegmentDurationOptions = {
  /** Opens the generation window inside the segment. */
  readonly first: (ev: unknown) => boolean
  readonly boundary: (ev: unknown) => boolean
  readonly event: (sample: DurationSample) => MetricEvent
}

type DurationState = {
  readonly segmentIndex: number
  readonly start: number
  readonly firstAt: Option.Option<number>
}

/** Segment wall time, and how much of it was spent generating. */
export const segmentDuration =
  (options: SegmentDurationOptions) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A | MetricEvent, E, R> =>
    Stream.unwrap(
      Effect.map(Clock.currentTimeMillis, (init) =>
        self.pipe(
          Stream.mapAccumEffect(
            (): DurationState => ({ segmentIndex: 0, start: init, firstAt: Option.none() }),
            (state, ev) =>
              Effect.map(Clock.currentTimeMillis, (now) => {
                const firstAt =
                  Option.isNone(state.firstAt) && options.first(ev)
                    ? Option.some(now)
                    : state.firstAt
                if (!options.boundary(ev)) return [{ ...state, firstAt }, [ev]] as const
                const duration = Duration.millis(now - state.start)
                const generation = Option.match(firstAt, {
                  onNone: () => Duration.zero,
                  onSome: (at) => Duration.millis(now - at),
                })
                const sample = options.event({
                  duration,
                  generation,
                  segmentIndex: state.segmentIndex,
                })
                const next: DurationState = {
                  segmentIndex: state.segmentIndex + 1,
                  start: now,
                  firstAt: Option.none(),
                }
                return [next, [ev, sample]] as const
              }),
          ),
        ),
      ),
    )
