import {
  Array as Arr,
  Clock,
  Duration,
  Effect,
  Match,
  Option,
  Predicate,
  Ref,
  Result,
  Schedule,
  Stream,
} from "effect"
import type { Usage } from "../domain/Items.js"
import type { Turn, TurnEvent } from "../domain/Turn.js"

// ---------------------------------------------------------------------------
// Self-describing measurements (the exporter-facing payload)
// ---------------------------------------------------------------------------

/**
 * The instrument-agnostic description of a single recorded value. The
 * `Telemetry` recorder reads only this: it builds (or reuses) a `Metric`
 * instrument from `kind` + `name` and updates it with `value`. A new metric,
 * built-in or user-defined, never requires a change to the recorder.
 */
export type Measurement = {
  readonly name: string
  readonly kind: "counter" | "histogram" | "timer" | "gauge"
  readonly value: number | Duration.Duration
  readonly attributes?: Readonly<Record<string, string>> | undefined
}

// ---------------------------------------------------------------------------
// MetricEvent: an open, brand-marked union (built-ins + user metrics)
// ---------------------------------------------------------------------------

/**
 * Brand stamped on every metric event. `isMetricEvent` checks this symbol,
 * not an enumerated `_tag`, so events are distinguished from `TurnEvent`s,
 * tool outputs, and arbitrary custom loop values regardless of their tag.
 * This is the same TypeId-symbol pattern Effect uses for `isStream` etc.
 */
export const MetricEventTypeId: unique symbol = Symbol.for(
  "@effect-uai/core/observability/MetricEvent",
)

/**
 * The structural contract every metric event satisfies, ours and custom.
 * The `_tag` + extra typed fields serve a frontend; the brand + `measurements`
 * serve the exporter.
 */
export type MetricEvent = {
  readonly [MetricEventTypeId]: typeof MetricEventTypeId
  readonly _tag: string
  /** Which turn within the piped stream this sample belongs to (0-based). */
  readonly turnIndex: number
  readonly measurements: ReadonlyArray<Measurement>
}

/** Request/turn start to the first content delta. */
export type TimeToFirstToken = MetricEvent & {
  readonly _tag: "TimeToFirstToken"
  readonly elapsed: Duration.Duration
  readonly kind: "text" | "reasoning"
}

/** A live output rate, emitted on the metronome cadence. */
export type Throughput = MetricEvent & {
  readonly _tag: "Throughput"
  readonly ratePerSecond: number
  readonly unit: "char" | "token" | "event"
  readonly window: Duration.Duration
}

/** Provider-reported usage at `TurnComplete`, this turn and cumulative. */
export type TokenTotals = MetricEvent & {
  readonly _tag: "TokenTotals"
  readonly usage: Usage
  readonly cumulative: Usage
}

/** Per-turn wall times at `TurnComplete`. */
export type TimeToCompletion = MetricEvent & {
  readonly _tag: "TimeToCompletion"
  readonly duration: Duration.Duration
  readonly generation: Duration.Duration
}

/**
 * Mint a custom metric event. Stamp it with the brand and provide a
 * well-formed `measurements` array; `Telemetry.record` will export it with no
 * changes to the recorder. The only constraint is that each measurement's
 * `kind` is one the recorder maps.
 */
export const makeEvent = <Fields extends Omit<MetricEvent, typeof MetricEventTypeId>>(
  fields: Fields,
): Fields & { readonly [MetricEventTypeId]: typeof MetricEventTypeId } => ({
  [MetricEventTypeId]: MetricEventTypeId,
  ...fields,
})

/** Structural (brand-based) guard for any metric event, built-in or custom. */
export const isMetricEvent = (u: unknown): u is MetricEvent =>
  Predicate.hasProperty(u, MetricEventTypeId)

/**
 * Project a stream of mixed events onto just its metric samples, for a side
 * channel or a frontend feed.
 */
export const metricEvents = <A, E, R>(
  self: Stream.Stream<A, E, R>,
): Stream.Stream<MetricEvent, E, R> =>
  self.pipe(Stream.filterMap((ev) => (isMetricEvent(ev) ? Result.succeed(ev) : Result.failVoid)))

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MetricName = {
  ttft: "effect_uai_turn_ttft",
  duration: "effect_uai_turn_duration",
  generation: "effect_uai_turn_generation",
  inputTokens: "effect_uai_input_tokens",
  outputTokens: "effect_uai_output_tokens",
  totalTokens: "effect_uai_total_tokens",
  reasoningTokens: "effect_uai_reasoning_tokens",
  cachedInputTokens: "effect_uai_cached_input_tokens",
} as const

/** Read a structural `_tag` off any value without narrowing to a closed union. */
const tagOf = (u: unknown): string | undefined =>
  Predicate.hasProperty(u, "_tag") && Predicate.isString(u._tag) ? u._tag : undefined

const contentDeltaKind = (ev: unknown): Option.Option<"text" | "reasoning"> => {
  const t = tagOf(ev)
  return t === "TextDelta"
    ? Option.some("text")
    : t === "ReasoningDelta"
      ? Option.some("reasoning")
      : Option.none()
}

const isTurnCompleteEvent = (ev: unknown): boolean => tagOf(ev) === "TurnComplete"

const turnOf = (ev: unknown): Turn =>
  (ev as Extract<TurnEvent, { readonly _tag: "TurnComplete" }>).turn

const sumOptional = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)

const addUsage = (a: Usage, b: Usage): Usage => {
  const cached = sumOptional(
    a.input_tokens_details?.cached_tokens,
    b.input_tokens_details?.cached_tokens,
  )
  const reasoning = sumOptional(
    a.output_tokens_details?.reasoning_tokens,
    b.output_tokens_details?.reasoning_tokens,
  )
  return {
    input_tokens: sumOptional(a.input_tokens, b.input_tokens),
    output_tokens: sumOptional(a.output_tokens, b.output_tokens),
    total_tokens: sumOptional(a.total_tokens, b.total_tokens),
    input_tokens_details: cached === undefined ? undefined : { cached_tokens: cached },
    output_tokens_details: reasoning === undefined ? undefined : { reasoning_tokens: reasoning },
  }
}

/** Per-turn token counts as incremental counter measurements (present fields only). */
const usageMeasurements = (usage: Usage): ReadonlyArray<Measurement> => {
  const pairs: ReadonlyArray<readonly [string, number | undefined]> = [
    [MetricName.inputTokens, usage.input_tokens],
    [MetricName.outputTokens, usage.output_tokens],
    [MetricName.totalTokens, usage.total_tokens],
    [MetricName.reasoningTokens, usage.output_tokens_details?.reasoning_tokens],
    [MetricName.cachedInputTokens, usage.input_tokens_details?.cached_tokens],
  ]
  return Arr.filterMap(pairs, ([name, value]) =>
    value === undefined
      ? Result.failVoid
      : Result.succeed<Measurement>({ name, kind: "counter", value }),
  )
}

// ---------------------------------------------------------------------------
// timeToFirstToken
// ---------------------------------------------------------------------------

export type TimeToFirstTokenOptions = {
  /**
   * Where the clock starts. `"request"` (default) anchors at stream
   * initialization, i.e. when the provider request fires, so the measurement
   * includes connection + prefill. `"first-event"` anchors at the first
   * emitted event, isolating decode latency.
   */
  readonly from?: "request" | "first-event"
}

type TtftState = {
  readonly turnIndex: number
  readonly turnStart: number
  readonly started: boolean
  readonly seen: boolean
}

export const timeToFirstToken =
  (options?: TimeToFirstTokenOptions) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A | MetricEvent, E, R> => {
    const fromRequest = (options?.from ?? "request") === "request"
    return Stream.unwrap(
      Effect.map(Clock.currentTimeMillis, (init) =>
        self.pipe(
          Stream.mapAccumEffect(
            (): TtftState => ({ turnIndex: 0, turnStart: init, started: fromRequest, seen: false }),
            (state, ev) =>
              Effect.map(Clock.currentTimeMillis, (now) => {
                const started = state.started ? state : { ...state, turnStart: now, started: true }
                const kind = contentDeltaKind(ev)
                const emitTtft = !started.seen && Option.isSome(kind)
                const out: ReadonlyArray<A | MetricEvent> = emitTtft
                  ? [
                      ev,
                      makeEvent<Omit<TimeToFirstToken, typeof MetricEventTypeId>>({
                        _tag: "TimeToFirstToken",
                        turnIndex: started.turnIndex,
                        elapsed: Duration.millis(now - started.turnStart),
                        kind: (kind as Option.Some<"text" | "reasoning">).value,
                        measurements: [
                          {
                            name: MetricName.ttft,
                            kind: "timer",
                            value: Duration.millis(now - started.turnStart),
                          },
                        ],
                      }),
                    ]
                  : [ev]
                const next: TtftState = isTurnCompleteEvent(ev)
                  ? {
                      turnIndex: started.turnIndex + 1,
                      turnStart: now,
                      started: fromRequest,
                      seen: false,
                    }
                  : { ...started, seen: started.seen || emitTtft }
                return [next, out] as const
              }),
          ),
        ),
      ),
    )
  }

// ---------------------------------------------------------------------------
// timeToCompletion
// ---------------------------------------------------------------------------

type CompletionState = {
  readonly turnIndex: number
  readonly turnStart: number
  readonly firstTokenAt: Option.Option<number>
}

export const timeToCompletion = <A, E, R>(
  self: Stream.Stream<A, E, R>,
): Stream.Stream<A | MetricEvent, E, R> =>
  Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (init) =>
      self.pipe(
        Stream.mapAccumEffect(
          (): CompletionState => ({ turnIndex: 0, turnStart: init, firstTokenAt: Option.none() }),
          (state, ev) =>
            Effect.map(Clock.currentTimeMillis, (now) => {
              const firstTokenAt =
                Option.isNone(state.firstTokenAt) && Option.isSome(contentDeltaKind(ev))
                  ? Option.some(now)
                  : state.firstTokenAt
              if (!isTurnCompleteEvent(ev)) {
                return [{ ...state, firstTokenAt }, [ev]] as const
              }
              const duration = Duration.millis(now - state.turnStart)
              const generation = Option.match(firstTokenAt, {
                onNone: () => Duration.zero,
                onSome: (ft) => Duration.millis(now - ft),
              })
              const event = makeEvent<Omit<TimeToCompletion, typeof MetricEventTypeId>>({
                _tag: "TimeToCompletion",
                turnIndex: state.turnIndex,
                duration,
                generation,
                measurements: [
                  { name: MetricName.duration, kind: "timer", value: duration },
                  { name: MetricName.generation, kind: "timer", value: generation },
                ],
              })
              const next: CompletionState = {
                turnIndex: state.turnIndex + 1,
                turnStart: now,
                firstTokenAt: Option.none(),
              }
              return [next, [ev, event]] as const
            }),
        ),
      ),
    ),
  )

// ---------------------------------------------------------------------------
// tokenTotals
// ---------------------------------------------------------------------------

const emptyUsage: Usage = {}

type TotalsState = {
  readonly turnIndex: number
  readonly cumulative: Usage
}

export const tokenTotals = <A, E, R>(
  self: Stream.Stream<A, E, R>,
): Stream.Stream<A | MetricEvent, E, R> =>
  self.pipe(
    Stream.mapAccumEffect(
      (): TotalsState => ({ turnIndex: 0, cumulative: emptyUsage }),
      (state, ev) =>
        Effect.sync(() => {
          if (!isTurnCompleteEvent(ev)) return [state, [ev]] as const
          const usage = turnOf(ev).usage
          const cumulative = addUsage(state.cumulative, usage)
          const event = makeEvent<Omit<TokenTotals, typeof MetricEventTypeId>>({
            _tag: "TokenTotals",
            turnIndex: state.turnIndex,
            usage,
            cumulative,
            measurements: usageMeasurements(usage),
          })
          return [{ turnIndex: state.turnIndex + 1, cumulative }, [ev, event]] as const
        }),
    ),
  )

// ---------------------------------------------------------------------------
// throughput
// ---------------------------------------------------------------------------

export type ThroughputOptions = {
  /** Tick interval. Default `"1 second"`. */
  readonly every?: Duration.Input
  /** What a "unit" is. Default `"char"` (exact and chunking-independent). */
  readonly unit?: "char" | "token" | "event"
  /** Token counter for `unit: "token"`. Absent => approximate 1 per content delta. */
  readonly tokenizer?: (event: TurnEvent) => Effect.Effect<number>
  /** Rate definition. Default `"windowed"` (current speed, no cold-start bias). */
  readonly mode?: "windowed" | "cumulative"
  /** EWMA smoothing. Omitted => off; `"default"` => a sensible factor. */
  readonly smooth?: "default" | number
}

/**
 * The throughput accumulator. Mutated by the source per content delta and read
 * by the metronome per tick.
 *
 * @internal
 */
export type RateState = {
  readonly units: number
  readonly lastUnits: number
  readonly lastMillis: number
  readonly firstMillis: Option.Option<number>
  readonly smoothed: Option.Option<number>
  readonly turnIndex: number
}

const initRateState: RateState = {
  units: 0,
  lastUnits: 0,
  lastMillis: 0,
  firstMillis: Option.none(),
  smoothed: Option.none(),
  turnIndex: 0,
}

const resolveSmooth = (smooth: ThroughputOptions["smooth"]): number | undefined =>
  smooth === undefined ? undefined : smooth === "default" ? 0.3 : smooth

/**
 * Pure per-tick rate computation. Returns `None` before the first token, else
 * the rate, the window it was measured over, and the next accumulator state.
 * Separated from the metronome so the rate math is unit-testable without time.
 *
 * @internal
 */
export const computeThroughputTick = (
  state: RateState,
  now: number,
  mode: "windowed" | "cumulative",
  smooth: number | undefined,
): Option.Option<{
  readonly rate: number
  readonly window: Duration.Duration
  readonly next: RateState
}> =>
  Option.map(state.firstMillis, (first) => {
    const windowMs = mode === "windowed" ? now - state.lastMillis : now - first
    const deltaUnits = mode === "windowed" ? state.units - state.lastUnits : state.units
    const instant = windowMs > 0 ? (deltaUnits / windowMs) * 1000 : 0
    const rate =
      smooth === undefined
        ? instant
        : Option.match(state.smoothed, {
            onNone: () => instant,
            onSome: (prev) => smooth * instant + (1 - smooth) * prev,
          })
    return {
      rate,
      window: Duration.millis(windowMs),
      next: { ...state, lastUnits: state.units, lastMillis: now, smoothed: Option.some(rate) },
    }
  })

const addUnits = (state: RateState, n: number, now: number): RateState =>
  Option.isNone(state.firstMillis)
    ? { ...state, units: n, lastUnits: 0, lastMillis: now, firstMillis: Option.some(now) }
    : { ...state, units: state.units + n }

const resetTurn = (state: RateState): RateState => ({
  ...initRateState,
  turnIndex: state.turnIndex + 1,
})

const unitCount = (
  ev: unknown,
  unit: "char" | "token" | "event",
  tokenizer: ThroughputOptions["tokenizer"],
): Effect.Effect<number> => {
  if (tagOf(ev) !== "TextDelta") return Effect.succeed(0)
  const text = (ev as { readonly text: string }).text
  return Match.value(unit).pipe(
    Match.when("char", () => Effect.succeed([...text].length)),
    Match.when("event", () => Effect.succeed(1)),
    Match.when("token", () =>
      tokenizer === undefined ? Effect.succeed(1) : tokenizer(ev as TurnEvent),
    ),
    Match.exhaustive,
  )
}

const throughputName = (unit: "char" | "token" | "event"): string =>
  `effect_uai_output_${unit}s_per_second`

export const throughput =
  (options?: ThroughputOptions) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A | MetricEvent, E, R> => {
    const unit = options?.unit ?? "char"
    const mode = options?.mode ?? "windowed"
    const every = options?.every ?? Duration.seconds(1)
    const smooth = resolveSmooth(options?.smooth)
    const tokenizer = options?.tokenizer
    const name = throughputName(unit)

    return Stream.unwrap(
      Effect.map(Ref.make(initRateState), (ref) => {
        const source = self.pipe(
          Stream.tap((ev) =>
            isTurnCompleteEvent(ev)
              ? Ref.update(ref, resetTurn)
              : tagOf(ev) === "TextDelta"
                ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
                    Effect.flatMap(unitCount(ev, unit, tokenizer), (n) =>
                      Ref.update(ref, (state) => addUnits(state, n, now)),
                    ),
                  )
                : Effect.void,
          ),
        )
        const metronome: Stream.Stream<MetricEvent> = Stream.fromSchedule(
          Schedule.spaced(every),
        ).pipe(
          Stream.mapEffect(() =>
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Ref.modify(ref, (state) =>
                Option.match(computeThroughputTick(state, now, mode, smooth), {
                  onNone: () => [Option.none<MetricEvent>(), state] as const,
                  onSome: ({ next, rate, window }) =>
                    [
                      Option.some<MetricEvent>(
                        makeEvent<Omit<Throughput, typeof MetricEventTypeId>>({
                          _tag: "Throughput",
                          turnIndex: state.turnIndex,
                          ratePerSecond: rate,
                          unit,
                          window,
                          measurements: [{ name, kind: "histogram", value: rate }],
                        }),
                      ),
                      next,
                    ] as const,
                }),
              ),
            ),
          ),
          Stream.filterMap((o) => (Option.isSome(o) ? Result.succeed(o.value) : Result.failVoid)),
        )
        return source.pipe(Stream.merge(metronome, { haltStrategy: "left" }))
      }),
    )
  }

// ---------------------------------------------------------------------------
// allMetrics
// ---------------------------------------------------------------------------

export type AllMetricsOptions = {
  readonly timeToFirstToken?: TimeToFirstTokenOptions
  readonly throughput?: ThroughputOptions
}

export const allMetrics =
  (options?: AllMetricsOptions) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A | MetricEvent, E, R> =>
    self.pipe(
      timeToFirstToken(options?.timeToFirstToken),
      throughput(options?.throughput),
      tokenTotals,
      timeToCompletion,
    )
