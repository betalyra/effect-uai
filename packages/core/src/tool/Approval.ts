/**
 * Approval: define what a user's answer to a waiting call can be, and get the
 * wire schema, the constructors and a resolver that groups waiting calls by
 * answer. Which calls wait and what each answer means is app code.
 */
import { Array as Arr, Function, HashMap, Option, Record, Result, Schema } from "effect"
import type { ToolCall } from "../domain/Items.js"

/** Each answer's fields; context-free schemas so the wire codec needs no services. */
type Variants = Record<string, Record<string, Schema.Codec<unknown, unknown, never, never>>>

/** A decision of a definition: `{ _tag: "Approve", ...fields } | ...`. */
export type DecisionOf<V extends Variants> = {
  [K in keyof V & string]: Schema.TaggedStruct<K, V[K]>["Type"]
}[keyof V & string]

type Fields<V extends Variants, K extends keyof V & string> = Omit<
  Extract<DecisionOf<V>, { readonly _tag: K }>,
  "_tag"
>

type Constructors<V extends Variants> = {
  readonly [K in keyof V & string]: {} extends Fields<V, K>
    ? (fields?: Fields<V, K>) => DecisionOf<V>
    : (fields: Fields<V, K>) => DecisionOf<V>
}

/** One decision for one call, as a client sends it. */
export type Answer<D> = { readonly callId: string; readonly decision: D }

/** Waiting calls grouped by the tag of their answer; `unanswered` got none. */
export type Resolved<V extends Variants> = {
  readonly [K in keyof V & string]: ReadonlyArray<{
    readonly call: ToolCall
    readonly decision: Extract<DecisionOf<V>, { readonly _tag: K }>
  }>
} & { readonly unanswered: ReadonlyArray<ToolCall> }

export type Decisions<V extends Variants> = Constructors<V> & {
  /** The wire form of a decision. */
  readonly schema: Schema.Codec<DecisionOf<V>, unknown>
  /** Group waiting calls by the answer each one got. Answers for other calls are ignored. */
  readonly resolve: {
    (answers: ReadonlyArray<Answer<DecisionOf<V>>>): (calls: ReadonlyArray<ToolCall>) => Resolved<V>
    (calls: ReadonlyArray<ToolCall>, answers: ReadonlyArray<Answer<DecisionOf<V>>>): Resolved<V>
  }
}

/**
 * Define the possible answers:
 *
 *   const Decisions = Approval.decisions({
 *     Approve: { always: Schema.optionalKey(Schema.Boolean) },
 *     Deny: { reason: Schema.optionalKey(Schema.String) },
 *   })
 *   const { Approve, Deny, unanswered } = Decisions.resolve(waiting, answers)
 */
export function decisions<const V extends Variants>(variants: V): Decisions<V>
export function decisions(variants: Variants): object {
  const tags = Object.keys(variants)
  const schema: Schema.Codec<DecisionOf<Variants>, unknown> = Schema.Union(
    Object.entries(variants).map(([tag, fields]) => Schema.TaggedStruct(tag, fields)),
  )
  const constructors = Object.fromEntries(
    tags.map((tag) => [tag, (fields: object = {}) => ({ _tag: tag, ...fields })]),
  )
  const resolve = Function.dual(
    2,
    (calls: ReadonlyArray<ToolCall>, answers: ReadonlyArray<Answer<{ readonly _tag: string }>>) => {
      const byId = HashMap.fromIterable(Arr.map(answers, (a) => [a.callId, a.decision] as const))
      const [answered, unanswered] = Arr.partition(calls, (call) =>
        Option.match(HashMap.get(byId, call.call_id), {
          onNone: () => Result.fail(call),
          onSome: (decision) => Result.succeed({ call, decision }),
        }),
      )
      const byTag = Arr.groupBy(answered, (a) => a.decision._tag)
      return {
        ...Record.fromIterableWith(tags, (tag) => [tag, byTag[tag] ?? []]),
        unanswered,
      }
    },
  )
  return { ...constructors, schema, resolve }
}

/** Approve, or deny with an optional reason. */
export const Default = decisions({
  Approve: {},
  Deny: { reason: Schema.optionalKey(Schema.String) },
})

/** What the model sees for a denied call. Define your own error for more fields. */
export class Denied extends Schema.TaggedError<Denied>("@betalyra/effect-uai/Denied")("Denied", {
  message: Schema.String,
}) {}
