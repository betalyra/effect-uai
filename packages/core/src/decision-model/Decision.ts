/**
 * Typed questions about one input, answered with probabilities.
 *
 * A {@link Definition} pairs the shape being read with the questions asked of
 * it. Build one at module scope and apply it per call with
 * `DecisionModel.decide`.
 *
 * @experimental The model class this abstracts is new and the shape may change.
 */
import {
  Array as A,
  Effect,
  Match,
  Number as N,
  Option,
  Order,
  Record,
  type Schema,
  pipe,
} from "effect"
import * as AiError from "../domain/AiError.js"
import * as Probability from "../math/Probability.js"

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

/** Labels mapped to what each one means. */
export type Labels = Readonly<Record<string, string>>

/** An ordered rubric, lowest level first. */
export type Levels = readonly [string, string, ...ReadonlyArray<string>]

/** What a true and a false answer mean, when the boundary is subtle. */
export type Boundary = { readonly true?: string; readonly false?: string }

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type ClassifyDecision<L extends Labels = Labels> = {
  readonly _tag: "Classify"
  readonly instructions: string
  readonly criteria: L
}

export type RateDecision<V extends Levels = Levels> = {
  readonly _tag: "Rate"
  readonly instructions: string
  readonly criteria: V
}

export type ProbabilityDecision = {
  readonly _tag: "Probability"
  readonly instructions: string
  readonly criteria?: Boundary
}

export type Decision = ClassifyDecision | RateDecision | ProbabilityDecision

/** Pick one label. Use {@link rate} when the options form a spectrum. */
export const classify = <const L extends Labels>(decision: {
  readonly instructions: string
  readonly criteria: L
}): ClassifyDecision<L> => ({ _tag: "Classify", ...decision })

/** Place the input on an ordered rubric. */
export const rate = <const V extends Levels>(decision: {
  readonly instructions: string
  readonly criteria: V
}): RateDecision<V> => ({ _tag: "Rate", ...decision })

/**
 * How likely a statement is to hold. Named for its answer rather than for an
 * act, unlike its siblings, so nobody reads the result as a boolean.
 */
export const probability = (decision: {
  readonly instructions: string
  readonly criteria?: Boundary
}): ProbabilityDecision => ({ _tag: "Probability", ...decision })

/** Decisions keyed by the name their answer comes back under. */
export type Decisions = { readonly [name: string]: Decision }

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * A reusable decision set bound to the shape it reads.
 *
 * `inputSchema` encodes the input on the way out, so a schema that omits a
 * field keeps it from the model. That projection is the supported way to hold
 * irrelevant or sensitive context out of a request.
 */
export type Definition<A_, D extends Decisions = Decisions> = {
  readonly inputSchema: Schema.Codec<A_, unknown, any, never>
  readonly decisions: D
}

/**
 * Build a decision set. Declare it once at module scope: the questions and
 * their rubrics are the reviewed artifact, the input changes per call.
 *
 * @example
 * ```ts
 * const triage = Decision.make({
 *   inputSchema: Schema.Struct({ message: Schema.String }),
 *   decisions: {
 *     department: Decision.classify({
 *       instructions: "Which team should handle this?",
 *       criteria: { billing: "Payments, invoicing", technical: "Bugs, outages" },
 *     }),
 *   },
 * })
 * ```
 */
export const make = <
  S extends Schema.Codec<any, any, any, never>,
  const D extends Decisions,
>(definition: {
  readonly inputSchema: S
  readonly decisions: D
}): Definition<S["Type"], D> => definition

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * Score contract for {@link ClassifyAnswer.labels} and
 * {@link RateAnswer.levels}: probabilities sum to 1 within floating-point
 * error and are comparable within one answer. Whether they are *calibrated*,
 * so a stated 0.8 means right about 80% of the time, is a property of the
 * Layer and is documented per provider. No implementor promises calibration
 * across requests, across decision kinds, or between a statement and its
 * negation: `P(claim) != 1 - P(not claim)`. A threshold fitted against one
 * model does not transfer to another.
 */
export type ClassifyAnswer<L extends Labels = Labels> = {
  readonly _tag: "Classify"
  readonly labels: Readonly<Record<keyof L & string, number>>
}

export type RateAnswer<V extends Levels = Levels> = {
  readonly _tag: "Rate"
  /** Index-aligned with {@link RateAnswer.legend}. */
  readonly levels: { readonly [K in keyof V]: number }
  /** The rubric, echoed so an index reads back as prose. */
  readonly legend: Readonly<V>
}

export type ProbabilityAnswer = {
  readonly _tag: "Probability"
  readonly probability: number
}

export type Answer = ClassifyAnswer | RateAnswer | ProbabilityAnswer

/** The answer a decision determines, keeping its labels or rubric. */
export type AnswerFor<D> = D extends {
  readonly _tag: "Classify"
  readonly criteria: infer L extends Labels
}
  ? ClassifyAnswer<L>
  : D extends { readonly _tag: "Rate"; readonly criteria: infer V extends Levels }
    ? RateAnswer<V>
    : ProbabilityAnswer

/** Answers keyed by their decision's name. */
export type Answers<D extends Decisions> = { readonly [K in keyof D]: AnswerFor<D[K]> }

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Fail `AiError.Unsupported` naming every decision whose kind this provider
 * cannot express. Bucket 1: omitting an answer would leave a hole where
 * {@link Answers} promises a key.
 *
 * Reports all offenders at once, since the definition is known up front.
 */
export const assertKinds = (
  decisions: Decisions,
  supported: ReadonlyArray<Decision["_tag"]>,
  provider: string,
): Effect.Effect<void, AiError.AiError> => {
  const offenders = pipe(
    Record.toEntries(decisions),
    A.filter(([, decision]) => !supported.includes(decision._tag)),
    A.map(([name, decision]) => `"${name}" is a ${decision._tag}`),
  )
  return offenders.length === 0
    ? Effect.void
    : Effect.fail(
        new AiError.Unsupported({
          provider,
          capability: "decision",
          reason: `${provider} answers ${supported.join(" / ")} only; ${offenders.join(", ")}.`,
        }),
      )
}

// ---------------------------------------------------------------------------
// Reading an answer
// ---------------------------------------------------------------------------

/** A `Probability` answer's implied distribution is `[p, 1 - p]`. */
export const probabilitiesOf: (answer: Answer) => ReadonlyArray<number> = Match.type<Answer>().pipe(
  Match.discriminatorsExhaustive("_tag")({
    Classify: (answer) => Record.values(answer.labels),
    Rate: (answer) => answer.levels,
    Probability: (answer) => [answer.probability, 1 - answer.probability],
  }),
)

/** See {@link Probability.confidence}. Defined for every kind. */
export const confidence = (answer: Answer): number =>
  Probability.confidence(probabilitiesOf(answer))

/** See {@link Probability.margin}. Defined for every kind. */
export const margin = (answer: Answer): number => Probability.margin(probabilitiesOf(answer))

const byProbability = Order.mapInput(
  Order.flip(Order.Number),
  (outcome: { readonly probability: number }) => outcome.probability,
)

/**
 * Labels best first. Ties keep first-seen order. Also the bridge to rank
 * fusion: map to `label` and pass alongside another retriever's ordering.
 */
export const ranked = <L extends Labels>(
  answer: ClassifyAnswer<L>,
): ReadonlyArray<{ readonly label: keyof L & string; readonly probability: number }> =>
  pipe(
    Record.toEntries(answer.labels),
    A.map(([label, probability]) => ({ label, probability })),
    A.sort(byProbability),
  )

/** Highest-probability label. `None` only when the label set is empty. */
export const winner = <L extends Labels>(
  answer: ClassifyAnswer<L>,
): Option.Option<keyof L & string> =>
  pipe(
    ranked(answer),
    A.head,
    Option.map((outcome) => outcome.label),
  )

/** Index of the highest-probability level. Ties resolve to the lowest. */
export const topLevel = (answer: RateAnswer): number =>
  pipe(
    answer.levels as ReadonlyArray<number>,
    A.reduce({ index: 0, probability: -Infinity }, (best, probability, index) =>
      probability > best.probability ? { index, probability } : best,
    ),
    (best) => best.index,
  )

/**
 * Probability-weighted mean of the level indices, so it can land between
 * them. Weakly calibrated in practice: a summary, not a magnitude to
 * interpolate. Use {@link topLevel} with `legend` to name a level instead.
 */
export const expectedLevel = (answer: RateAnswer): number =>
  pipe(
    answer.levels as ReadonlyArray<number>,
    A.map((probability, index) => index * probability),
    N.sumAll,
  )
