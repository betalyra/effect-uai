/**
 * Provider-reported token usage, accumulated over whatever segments it is
 * handed: a turn, a response, anything that reports its own totals.
 *
 * The counters carry the same names wherever the usage came from, so spend
 * adds up across capabilities without the exporter knowing which meter
 * produced a row.
 */
import {
  Array as Arr,
  Effect,
  Number as Num,
  Option,
  Reducer,
  Result,
  Stream,
  Struct,
} from "effect"
import type { Usage } from "../../domain/Items.js"
import { type Measurement, type MetricEvent, MetricEventTypeId, makeEvent } from "./MetricEvent.js"

const MetricName = {
  inputTokens: "effect_uai_input_tokens",
  outputTokens: "effect_uai_output_tokens",
  totalTokens: "effect_uai_total_tokens",
  reasoningTokens: "effect_uai_reasoning_tokens",
  cachedInputTokens: "effect_uai_cached_input_tokens",
  cacheWriteTokens: "effect_uai_cache_write_tokens",
} as const

/** Provider-reported usage at a segment boundary, this segment and cumulative. */
export type TokenTotals = MetricEvent & {
  readonly _tag: "TokenTotals"
  readonly usage: Usage
  readonly cumulative: Usage
}

/** A field that may simply not be there, combined only when both sides are. */
const absent = <A>(inner: Reducer.Reducer<A>): Reducer.Reducer<A | undefined> =>
  Reducer.make<A | undefined>((self, that) => {
    if (self === undefined) return that
    if (that === undefined) return self
    return inner.combine(self, that)
  }, undefined)

const omitAbsent = { omitKeyWhen: (value: unknown) => value === undefined }

const Tokens = absent(Num.ReducerSum)

const InputDetails = absent(
  Struct.makeReducer<NonNullable<Usage["input_tokens_details"]>>(
    { cached_tokens: Tokens, cache_write_tokens: Tokens },
    omitAbsent,
  ),
)

const OutputDetails = absent(
  Struct.makeReducer<NonNullable<Usage["output_tokens_details"]>>(
    { reasoning_tokens: Tokens },
    omitAbsent,
  ),
)

/**
 * Summing usage is a monoid, so it is one: absent fields stay absent, and the
 * empty total is the identity rather than a hand-written zero. `combineAll`
 * folds a whole collection, which is what a cumulative meter wants.
 */
export const ReducerUsage: Reducer.Reducer<Usage> = Struct.makeReducer<Usage>(
  {
    input_tokens: Tokens,
    output_tokens: Tokens,
    total_tokens: Tokens,
    input_tokens_details: InputDetails,
    output_tokens_details: OutputDetails,
  },
  omitAbsent,
)

/** Token counts as incremental counter measurements, present fields only. */
const measurementsOf = (usage: Usage): ReadonlyArray<Measurement> =>
  Arr.filterMap(
    [
      [MetricName.inputTokens, usage.input_tokens],
      [MetricName.outputTokens, usage.output_tokens],
      [MetricName.totalTokens, usage.total_tokens],
      [MetricName.reasoningTokens, usage.output_tokens_details?.reasoning_tokens],
      [MetricName.cachedInputTokens, usage.input_tokens_details?.cached_tokens],
      [MetricName.cacheWriteTokens, usage.input_tokens_details?.cache_write_tokens],
    ] as const,
    ([name, value]) =>
      value === undefined
        ? Result.failVoid
        : Result.succeed<Measurement>({ name, kind: "counter", value }),
  )

export type UsageTotalsOptions = {
  /** Ends a segment, whether or not it reported any usage. */
  readonly boundary: (ev: unknown) => boolean
  /** What this element reports. `None` emits nothing for that segment. */
  readonly usage: (ev: unknown) => Option.Option<Usage>
}

type TotalsState = {
  readonly segmentIndex: number
  readonly cumulative: Usage
}

/**
 * Usage per segment, and summed over every segment seen so far. The scope is
 * whatever stream you pipe in: one generation, or a whole loop.
 */
export const usageTotals =
  (options: UsageTotalsOptions) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A | MetricEvent, E, R> =>
    self.pipe(
      Stream.mapAccumEffect(
        (): TotalsState => ({ segmentIndex: 0, cumulative: ReducerUsage.initialValue }),
        (state, ev) =>
          Effect.sync(() => {
            const closed = options.boundary(ev)
              ? { ...state, segmentIndex: state.segmentIndex + 1 }
              : state
            return Option.match(options.usage(ev), {
              onNone: () => [closed, [ev]] as const,
              onSome: (reported) => {
                const cumulative = ReducerUsage.combine(state.cumulative, reported)
                const sample = makeEvent<Omit<TokenTotals, typeof MetricEventTypeId>>({
                  _tag: "TokenTotals",
                  turnIndex: state.segmentIndex,
                  usage: reported,
                  cumulative,
                  measurements: measurementsOf(reported),
                })
                return [{ ...closed, cumulative }, [ev, sample]] as const
              },
            })
          }),
      ),
    )
