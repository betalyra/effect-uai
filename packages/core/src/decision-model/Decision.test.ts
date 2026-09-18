import { describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { expect, expectTypeOf } from "vitest"
import * as AiError from "../domain/AiError.js"
import * as Decision from "./Decision.js"
import { decide, DecisionModel, type DecisionModelService } from "./DecisionModel.js"

const triage = Decision.make({
  inputSchema: Schema.Struct({ message: Schema.String }),
  decisions: {
    department: Decision.classify({
      instructions: "Which team should handle this?",
      criteria: { billing: "Payments, invoicing", technical: "Bugs, outages" },
    }),
    severity: Decision.rate({
      instructions: "How severe is it?",
      criteria: ["Cosmetic", "Degraded", "Blocking"],
    }),
    urgent: Decision.probability({ instructions: "Does this convey urgency?" }),
  },
})

const fixture = {
  department: { _tag: "Classify", labels: { billing: 0.62, technical: 0.38 } },
  severity: { _tag: "Rate", levels: [0, 0.7, 0.3], legend: ["Cosmetic", "Degraded", "Blocking"] },
  urgent: { _tag: "Probability", probability: 0.94 },
} as const

/**
 * A fixed fixture cannot prove it satisfies the caller's `Answers<D>`. This is
 * the boundary a provider casts at too, once it has decoded the wire.
 */
const fixed = <D extends Decision.Decisions>(
  answers: Readonly<Record<string, Decision.Answer>>,
): Decision.Answers<D> => answers as Decision.Answers<D>

type Call = { readonly input: unknown; readonly model: string }

/** A `DecisionModel` layer that records what reached it. */
const recording = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<Call>>([])
  const service: DecisionModelService = {
    decide: (_definition, request) =>
      Effect.as(
        Ref.update(calls, (seen) => [...seen, { input: request.input, model: request.model }]),
        { answers: fixed(fixture), usage: {} },
      ),
  }
  return { calls, layer: Layer.succeed(DecisionModel, service) }
})

describe("the answer map is derived from the definition", () => {
  it.effect("keeps each decision's label keys and rejects labels it never had", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* recording
      const result = yield* decide(triage, {
        model: "jev-latest",
        input: { message: "hi" },
      }).pipe(Effect.provide(layer))

      expectTypeOf(result.answers.department.labels).toEqualTypeOf<{
        readonly billing: number
        readonly technical: number
      }>()
      // @ts-expect-error shipping is not a label of this decision
      result.answers.department.labels.shipping
      // @ts-expect-error a Probability answer has no labels
      result.answers.urgent.labels

      // `decide` forwards both arguments rather than dropping either.
      expect(yield* Ref.get(calls)).toEqual([{ input: { message: "hi" }, model: "jev-latest" }])
    }),
  )

  it("keeps the rubric as a tuple, so levels are positional rather than parsed", () => {
    type Severity = (typeof triage)["decisions"]["severity"]
    expectTypeOf<Decision.AnswerFor<Severity>["levels"]>().toEqualTypeOf<
      readonly [number, number, number]
    >()
    expectTypeOf<Decision.AnswerFor<Severity>["legend"]>().toEqualTypeOf<
      readonly ["Cosmetic", "Degraded", "Blocking"]
    >()
  })
})

describe("reading an answer", () => {
  it("derives a Probability answer's distribution as [p, 1 - p]", () => {
    const [yes, no] = Decision.probabilitiesOf(fixture.urgent)
    expect(yes).toBeCloseTo(0.94, 10)
    expect(no).toBeCloseTo(0.06, 10)
  })

  it("ranks labels best first and names the winner", () => {
    expect(Decision.ranked(fixture.department)).toEqual([
      { label: "billing", probability: 0.62 },
      { label: "technical", probability: 0.38 },
    ])
    expect(Decision.winner(fixture.department)).toStrictEqual(Option.some("billing"))
  })

  it("has no winner for an empty label set", () => {
    expect(Decision.winner({ _tag: "Classify", labels: {} })).toStrictEqual(Option.none())
  })

  it("reads a rubric by index and by expected value", () => {
    expect(Decision.topLevel(fixture.severity)).toBe(1)
    expect(Decision.expectedLevel(fixture.severity)).toBeCloseTo(1.3, 10)
    expect(fixture.severity.legend[Decision.topLevel(fixture.severity)]).toBe("Degraded")
  })

  it("resolves a level tie to the lowest index", () => {
    expect(Decision.topLevel({ _tag: "Rate", levels: [0.5, 0.5], legend: ["a", "b"] })).toBe(0)
  })

  it("computes certainty for every kind, including Probability", () => {
    expect(Decision.confidence(fixture.urgent)).toBeCloseTo(0.67, 2)
    expect(Decision.margin(fixture.urgent)).toBeCloseTo(0.88, 10)
    expect(Decision.margin(fixture.department)).toBeCloseTo(0.24, 10)
  })
})

describe("assertKinds", () => {
  const supported = ["Classify", "Probability"] as const

  it.effect("passes when every kind is supported", () => {
    const { department, urgent } = triage.decisions
    return Decision.assertKinds({ department, urgent }, supported, "nli")
  })

  it.effect("fails Unsupported and names every offender at once", () =>
    Effect.gen(function* () {
      const decisions = {
        ...triage.decisions,
        impact: Decision.rate({ instructions: "How bad?", criteria: ["low", "high"] }),
      }
      const error = yield* Effect.flip(Decision.assertKinds(decisions, supported, "nli"))

      expect(error).toBeInstanceOf(AiError.Unsupported)
      if (error._tag !== "Unsupported") return

      expect(error.reason).toContain('"severity" is a Rate')
      expect(error.reason).toContain('"impact" is a Rate')
      expect(error.reason).not.toContain("department")
    }),
  )
})
