import { describe, it } from "@effect/vitest"
import { Effect, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Decision from "@effect-uai/core/Decision"
import { expect } from "vitest"
import { make } from "./GeminiDecisionModel.js"

const returns = Decision.make({
  inputSchema: Schema.Struct({ note: Schema.String }),
  decisions: {
    visible_damage: Decision.probability({
      instructions: "Does the photo show physical damage to the device?",
      criteria: { true: "The device is visibly broken.", false: "No visible damage." },
    }),
    next_action: Decision.classify({
      instructions: "What is the right resolution?",
      criteria: {
        instant_refund: "Refund without return.",
        replacement_shipment: "Ship a replacement.",
        human_escalation: "",
      },
    }),
    severity: Decision.rate({
      instructions: "How severe is the damage?",
      criteria: ["Cosmetic only.", "Partially functional.", "Unusable."],
    }),
  },
})

/** The response example from Google's Decisions API guide. */
const documented = {
  answers: {
    visible_damage: { type: "noul", noul: 0.97, confidence: 0.97 },
    next_action: {
      type: "choice",
      choice: "replacement_shipment",
      probabilities: { human_escalation: 0.1, instant_refund: 0.23, replacement_shipment: 0.67 },
      confidence: 0.67,
    },
    severity: {
      type: "score",
      score: 1.12,
      legend: { "0": "Cosmetic only.", "1": "Partially functional.", "2": "Unusable." },
      probabilities: { "2": 0.14, "0": 0.03, "1": 0.83 },
      confidence: 0.83,
    },
  },
  usage: { total_input_tokens: 324, total_output_tokens: 0, total_tokens: 324 },
}

/** Answers every request with `body` under `status`, keeping the bodies it was sent. */
const serving = (status: number, body: unknown) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<unknown>>([])
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const text =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
        yield* Ref.update(sent, (all) => [...all, JSON.parse(text)])
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))
      }),
    )
    const service = yield* make({ apiKey: Redacted.make("key") }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    )
    return { service, sent }
  })

const request = { model: "gemini-decision-1", input: { note: "Cracked screen, photo attached." } }

describe("GeminiDecisionModel", () => {
  it.effect("answers all three kinds, reading score levels back by index", () =>
    Effect.gen(function* () {
      const { service, sent } = yield* serving(200, documented)
      const { answers, usage } = yield* service.decide(returns, request)

      expect(answers.visible_damage).toEqual({
        _tag: "Probability",
        probability: 0.97,
        confidence: 0.97,
      })
      expect(answers.next_action.labels.replacement_shipment).toBe(0.67)
      expect(answers.severity.levels).toEqual([0.03, 0.83, 0.14])
      expect(usage).toEqual({ inputTokens: 324, outputTokens: 0 })
      expect(yield* Ref.get(sent)).toMatchObject([
        {
          input: '{"note":"Cracked screen, photo attached."}',
          questions: {
            visible_damage: {
              type: "noul",
              criteria: {
                true_description: "The device is visibly broken.",
                false_description: "No visible damage.",
              },
            },
          },
        },
      ])
    }),
  )

  it.effect("rejects keys outside Google's limits before sending anything", () =>
    Effect.gen(function* () {
      const { service, sent } = yield* serving(200, documented)
      const bad = Decision.make({
        inputSchema: Schema.String,
        decisions: {
          "has space": Decision.probability({ instructions: "?" }),
          route: Decision.classify({ instructions: "?", criteria: { " padded": "", ok: "" } }),
        },
      })

      const error = yield* Effect.flip(service.decide(bad, { ...request, input: "x" }))
      expect(error).toMatchObject({
        _tag: "InvalidRequest",
        raw: expect.stringMatching(/"has space".*" padded"/),
      })
      expect(yield* Ref.get(sent)).toEqual([])
    }),
  )

  it.effect("fails ContentFiltered when the safety filter blocks the input", () =>
    Effect.gen(function* () {
      const { service } = yield* serving(400, {
        error: { code: "safety", message: "Input blocked: harmful content." },
      })
      const error = yield* Effect.flip(service.decide(returns, request))
      expect(error).toMatchObject({
        _tag: "ContentFiltered",
        reason: "Input blocked: harmful content.",
      })
    }),
  )
})
