/**
 * Approval: define what an answer to a waiting call can be, and get the wire
 * schema, the constructors and a resolver that groups waiting calls by answer.
 * Which calls wait and what each answer means is app code; tools and toolkits
 * know nothing about decisions.
 */
import { Array as Arr, Function, HashMap, Option, Record, Result, Schema } from "effect"
import type { ToolCall } from "../domain/Items.js"

/** A decision's fields; context-free schemas so the wire codec needs no services. */
type Fields = Record<string, Schema.Codec<unknown, unknown, never, never>>

/** A decision that ends the call with an error, built from the decision's fields. */
export type Closing<F extends Fields, E> = {
  readonly _tag: "Closing"
  readonly fields: F
  readonly error: (decision: Schema.Struct.Type<F>) => E
}

/**
 * A decision that ends the call with an error, e.g. `Deny` with `Denied`. The
 * resolver builds the error, so a decision can only end in the error it names.
 */
export const closesWith = <const F extends Fields, E>(
  fields: F,
  error: (decision: Schema.Struct.Type<F>) => E,
): Closing<F, E> => ({ _tag: "Closing", fields, error })

type Variants = Record<string, Fields | Closing<any, any>>

type FieldsOf<X> = X extends Closing<infer F, any> ? F : X extends Fields ? X : never

/** A decision of a definition: `{ _tag: "Approve", ...fields } | ...`. */
export type DecisionOf<V extends Variants> = {
  [K in keyof V & string]: Schema.TaggedStruct<K, FieldsOf<V[K]>>["Type"]
}[keyof V & string]

type FieldsType<V extends Variants, K extends keyof V & string> = Omit<
  Extract<DecisionOf<V>, { readonly _tag: K }>,
  "_tag"
>

type Constructors<V extends Variants> = {
  readonly [K in keyof V & string]: {} extends FieldsType<V, K>
    ? (fields?: FieldsType<V, K>) => DecisionOf<V>
    : (fields: FieldsType<V, K>) => DecisionOf<V>
}

/** One decision for one call, as a client sends it. */
export type Answer<D> = { readonly callId: string; readonly decision: D }

/** An answer the call's decisions don't accept (wrong tag or fields). */
export type Invalid = { readonly call: ToolCall; readonly decision: unknown }

/** One group: the calls answered with tag `K`; a closing decision also carries its error. */
type Group<V extends Variants, K extends keyof V & string> = ReadonlyArray<
  {
    readonly call: ToolCall
    readonly decision: Extract<DecisionOf<V>, { readonly _tag: K }>
  } & (V[K] extends Closing<any, infer E> ? { readonly error: E } : {})
>

type Groups<V extends Variants> = { readonly [K in keyof V & string]: Group<V, K> }

/** Waiting calls grouped by the tag of their answer; `unanswered` got none, `invalid` a wrong one. */
export type Resolved<V extends Variants> = Groups<V> & {
  readonly unanswered: ReadonlyArray<ToolCall>
  readonly invalid: ReadonlyArray<Invalid>
}

type ResolveFn<R> = {
  (answers: ReadonlyArray<Answer<unknown>>): (calls: ReadonlyArray<ToolCall>) => R
  (calls: ReadonlyArray<ToolCall>, answers: ReadonlyArray<Answer<unknown>>): R
}

export type Decisions<V extends Variants> = Constructors<V> & {
  readonly variants: V
  /** The wire form of a decision. */
  readonly schema: Schema.Codec<DecisionOf<V>, unknown>
  /**
   * Group waiting calls by the answer each one got. Each answer is checked
   * against this definition; answers for other calls are ignored.
   */
  readonly resolve: ResolveFn<Resolved<V>>
}

const answersById = (answers: ReadonlyArray<Answer<unknown>>) =>
  HashMap.fromIterable(Arr.map(answers, (a) => [a.callId, a.decision] as const))

/**
 * Define the possible answers:
 *
 *   const RefundDecisions = Approval.decisions({
 *     Approve: {},
 *     Reduce: { amount: Schema.Number },
 *     Deny: Approval.closesWith({ reason: Schema.String }, ({ reason }) => new Denied({ message: reason })),
 *   })
 *   const { Approve, Reduce, Deny, unanswered, invalid } = RefundDecisions.resolve(waiting, answers)
 */
export function decisions<const V extends Variants>(variants: V): Decisions<V>
export function decisions(variants: Variants): object {
  const fieldsOf = (variant: Fields | Closing<Fields, unknown>): Fields =>
    isClosing(variant) ? variant.fields : variant
  const tags = Object.keys(variants)
  const schema: Schema.Codec<{ readonly _tag: string }, unknown> = Schema.Union(
    Object.entries(variants).map(([tag, variant]) => Schema.TaggedStruct(tag, fieldsOf(variant))),
  )
  const accepts = Schema.is(schema)
  const constructors = Object.fromEntries(
    tags.map((tag) => [tag, (fields: object = {}) => ({ _tag: tag, ...fields })]),
  )
  // A closing decision brings its error along, built from the answer's fields.
  const withError = (entry: {
    readonly call: ToolCall
    readonly decision: { readonly _tag: string }
  }) =>
    Option.match(
      Option.fromNullishOr(variants[entry.decision._tag]).pipe(Option.filter(isClosing)),
      {
        onNone: () => entry,
        onSome: (closing) => ({ ...entry, error: closing.error(entry.decision) }),
      },
    )
  const resolve = Function.dual(
    2,
    (calls: ReadonlyArray<ToolCall>, answers: ReadonlyArray<Answer<unknown>>) => {
      const byId = answersById(answers)
      const [answered, unanswered] = Arr.partition(calls, (call) =>
        Option.match(HashMap.get(byId, call.call_id), {
          onNone: () => Result.fail(call),
          onSome: (decision) => Result.succeed({ call, decision }),
        }),
      )
      const [valid, invalid] = Arr.partition(answered, ({ call, decision }) =>
        accepts(decision) ? Result.succeed({ call, decision }) : Result.fail({ call, decision }),
      )
      const byTag = Arr.groupBy(Arr.map(valid, withError), (a) => a.decision._tag)
      return {
        ...Record.fromIterableWith(tags, (tag) => [tag, byTag[tag] ?? []]),
        unanswered,
        invalid,
      }
    },
  )
  return { ...constructors, variants, schema, resolve }
}

const isClosing = (
  variant: Fields | Closing<Fields, unknown>,
): variant is Closing<Fields, unknown> => variant["_tag"] === "Closing"

/** What the model sees for a denied call. Define your own error for more fields. */
export class Denied extends Schema.TaggedError<Denied>("@betalyra/effect-uai/Denied")("Denied", {
  message: Schema.String,
}) {}

/** Approve, or deny with an optional reason; `Deny` ends the call with `Denied`. */
export const Default = decisions({
  Approve: {},
  Deny: closesWith(
    { reason: Schema.optionalKey(Schema.String) },
    ({ reason }) => new Denied({ message: reason ?? "The user declined." }),
  ),
})

// ---------------------------------------------------------------------------
// Decisions per tool
// ---------------------------------------------------------------------------

type AnyDecisions = Decisions<any>
type VariantsOf<D> = D extends Decisions<infer V> ? V : never
// Distributes over a union of sets, so each keeps its own tags.
type DecisionsOf<D> = D extends Decisions<infer V> ? DecisionOf<V> : never
type Table = Record<string, AnyDecisions>

/** The decision a call of tool `N` takes: its own set, else the fallback. */
export type DecisionFor<M extends Table, F, N extends string> = N extends keyof M
  ? DecisionsOf<M[N]>
  : DecisionsOf<F>

/** Each tool's groups, `fallback` for the rest, then what's left unanswered or invalid. */
export type ResolvedByTool<M extends Table, F> = {
  readonly [K in keyof M & string]: Groups<VariantsOf<M[K]>>
} & (F extends AnyDecisions ? { readonly fallback: Groups<VariantsOf<F>> } : {}) & {
    readonly unanswered: ReadonlyArray<ToolCall>
    readonly invalid: ReadonlyArray<Invalid>
  }

export type ByTool<M extends Table, F> = {
  readonly tools: M
  /** The wire form of any answer: every set's decisions. */
  readonly schema: Schema.Codec<DecisionsOf<M[keyof M]> | DecisionsOf<F>, unknown>
  /** An answer to a waiting call, typed by its tool's decisions. */
  readonly answer: <N extends string>(
    interrupt: { readonly callId: string; readonly name: N },
    decision: DecisionFor<M, F, N>,
  ) => Answer<DecisionFor<M, F, N>>
  /** Resolve every waiting call with its own tool's decisions. */
  readonly resolve: ResolveFn<ResolvedByTool<M, F>>
}

/**
 * The decisions each tool takes, in app code:
 *
 *   const Decisions = Approval.byTool(
 *     { issue_refund: RefundDecisions, send_email: EmailDecisions },
 *     { fallback: Approval.Default },
 *   )
 *
 * A call whose tool has no set (and no fallback) can't be answered: it stays
 * `unanswered`, or lands in `invalid` when an answer arrives for it.
 */
export function byTool<const M extends Table>(tools: M): ByTool<M, undefined>
export function byTool<const M extends Table, F extends AnyDecisions>(
  tools: M,
  options: { readonly fallback: F },
): ByTool<M, F>
export function byTool(tools: Table, options?: { readonly fallback?: AnyDecisions }): object {
  const fallback = options?.fallback
  const sets = [...Object.values(tools), ...(fallback === undefined ? [] : [fallback])]
  const schema = Schema.Union(sets.map((set) => set.schema))
  const setOf = (call: ToolCall): Option.Option<AnyDecisions> =>
    Option.orElse(
      Option.fromNullishOr(Object.hasOwn(tools, call.name) ? tools[call.name] : undefined),
      () => Option.fromNullishOr(fallback),
    )
  const groupsOf = (resolved: Record<string, unknown>) => {
    const { unanswered: _u, invalid: _i, ...groups } = resolved
    return groups
  }
  const resolve = Function.dual(
    2,
    (calls: ReadonlyArray<ToolCall>, answers: ReadonlyArray<Answer<unknown>>) => {
      const [covered, uncovered] = Arr.partition(calls, (call) =>
        Option.match(setOf(call), {
          onNone: () => Result.fail(call),
          onSome: () => Result.succeed(call),
        }),
      )
      const named = Object.entries(tools).map(([name, set]) => {
        const resolved = set.resolve(
          covered.filter((call) => call.name === name),
          answers,
        )
        return [name, resolved] as const
      })
      const rest = Option.map(Option.fromNullishOr(fallback), (set) =>
        set.resolve(
          covered.filter((call) => !Object.hasOwn(tools, call.name)),
          answers,
        ),
      )
      const all = [...named.map(([, r]) => r), ...Option.toArray(rest)]
      // A call nobody takes decisions for: an answer to it is invalid.
      const byId = answersById(answers)
      const [orphaned, waiting] = Arr.partition(uncovered, (call) =>
        Option.match(HashMap.get(byId, call.call_id), {
          onNone: () => Result.fail(call),
          onSome: (decision) => Result.succeed({ call, decision }),
        }),
      )
      return {
        ...Object.fromEntries(named.map(([name, r]) => [name, groupsOf(r)])),
        ...Option.match(rest, { onNone: () => ({}), onSome: (r) => ({ fallback: groupsOf(r) }) }),
        unanswered: [...all.flatMap((r) => r.unanswered), ...waiting],
        invalid: [...all.flatMap((r) => r.invalid), ...orphaned],
      }
    },
  )
  return {
    tools,
    schema,
    answer: (interrupt: { readonly callId: string }, decision: unknown) => ({
      callId: interrupt.callId,
      decision,
    }),
    resolve,
  }
}
