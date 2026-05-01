import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import { type CouncilEvent, council } from "./council.js"

describe("model-council", () => {
  const finalTurn = (text: string): Turn.Turn => ({
    stop_reason: "stop",
    usage: { input_tokens: 4, output_tokens: 4, total_tokens: 8 },
    items: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  })

  const scoreTurn = (score: number, rationale: string): Turn.Turn =>
    finalTurn(JSON.stringify({ score, rationale }))

  const failingService = (error: AiError.AiError): LanguageModelService => ({
    streamTurn: () => Stream.fail(error),
  })

  const history: ReadonlyArray<Items.Item> = [Items.userText("compare these")]

  it("generates candidates, cross-evaluates, and streams the winner with no self-judging", async () => {
    // Each member is called 3x: 1 generate + 2 judge (one per other subject).
    // Per-judge scores are constant so the test doesn't depend on subject ordering.
    const { service: openai } = MockProvider.make([
      finalTurn("from-openai"),
      scoreTurn(9, "o1"),
      scoreTurn(9, "o2"),
    ])
    const { service: google } = MockProvider.make([
      finalTurn("from-google"),
      scoreTurn(5, "g1"),
      scoreTurn(5, "g2"),
    ])
    const { service: anthropic } = MockProvider.make([
      finalTurn("from-anthropic"),
      scoreTurn(7, "a1"),
      scoreTurn(7, "a2"),
    ])

    const events = await Effect.runPromise(
      Stream.runCollect(
        council(
          [
            { name: "openai", service: openai },
            { name: "google", service: google },
            { name: "anthropic", service: anthropic },
          ],
          history,
        ),
      ),
    )

    // Three candidate completions, with the right text per member.
    const completes = events.filter(
      (e): e is Extract<CouncilEvent, { type: "candidate_complete" }> =>
        e.type === "candidate_complete",
    )
    expect(completes).toHaveLength(3)
    const answers = new Map(completes.map((c) => [c.member, c.answer]))
    expect(answers.get("openai")).toBe("from-openai")
    expect(answers.get("google")).toBe("from-google")
    expect(answers.get("anthropic")).toBe("from-anthropic")

    // Six score events, exactly the cross-product minus the diagonal.
    const scores = events.filter(
      (e): e is Extract<CouncilEvent, { type: "score" }> => e.type === "score",
    )
    expect(scores).toHaveLength(6)
    for (const s of scores) expect(s.judge).not.toBe(s.subject)

    const pairs = new Set(scores.map((s) => `${s.judge}->${s.subject}`))
    expect(pairs).toEqual(
      new Set([
        "openai->google",
        "openai->anthropic",
        "google->openai",
        "google->anthropic",
        "anthropic->openai",
        "anthropic->google",
      ]),
    )

    // Score values track the judge, not the subject.
    for (const s of scores) {
      const expected = s.judge === "openai" ? 9 : s.judge === "google" ? 5 : 7
      expect(s.score).toBe(expected)
    }

    // Winner: subject with the highest average judges' score.
    //   openai:    avg(google=5, anthropic=7) = 6
    //   google:    avg(openai=9, anthropic=7) = 8   <-- winner
    //   anthropic: avg(openai=9, google=5)    = 7
    const winners = events.filter(
      (e): e is Extract<CouncilEvent, { type: "winner" }> => e.type === "winner",
    )
    expect(winners).toHaveLength(1)
    expect(winners[0]!.member).toBe("google")
    expect(winners[0]!.answer).toBe("from-google")
    expect(winners[0]!.averageScore).toBe(8)
  })

  it("tags every candidate text delta with its member and accumulates the answer", async () => {
    const { service: openai } = MockProvider.make([
      finalTurn("alpha"),
      scoreTurn(1, ""),
      scoreTurn(1, ""),
    ])
    const { service: google } = MockProvider.make([
      finalTurn("beta"),
      scoreTurn(1, ""),
      scoreTurn(1, ""),
    ])
    const { service: anthropic } = MockProvider.make([
      finalTurn("gamma"),
      scoreTurn(1, ""),
      scoreTurn(1, ""),
    ])

    const events = await Effect.runPromise(
      Stream.runCollect(
        council(
          [
            { name: "openai", service: openai },
            { name: "google", service: google },
            { name: "anthropic", service: anthropic },
          ],
          history,
        ),
      ),
    )

    const textPerMember = new Map<string, string>()
    for (const e of events) {
      if (e.type === "candidate_delta" && e.delta.type === "text_delta") {
        textPerMember.set(
          e.member,
          (textPerMember.get(e.member) ?? "") + e.delta.text,
        )
      }
    }
    expect(textPerMember.get("openai")).toBe("alpha")
    expect(textPerMember.get("google")).toBe("beta")
    expect(textPerMember.get("anthropic")).toBe("gamma")
  })

  it("isolates a failing member: no judges of its subject, judge-phase failures don't kill the winner", async () => {
    // openai always fails (generate + any judge call). google and anthropic
    // generate normally and each judges the other.
    //   - openai's pipeline emits a generate-error event (no candidate_complete
    //     -> no judges of subject openai are spawned at all).
    //   - google completes -> spawns judges {openai (fails), anthropic (succeeds)}.
    //   - anthropic completes -> spawns judges {openai (fails), google (succeeds)}.
    const openai = failingService(
      new AiError.RateLimited({ provider: "openai", raw: "limit" }),
    )
    const { service: google } = MockProvider.make([
      finalTurn("from-google"),
      scoreTurn(4, "g-judges-anthropic"),
    ])
    const { service: anthropic } = MockProvider.make([
      finalTurn("from-anthropic"),
      scoreTurn(8, "a-judges-google"),
    ])

    const events = await Effect.runPromise(
      Stream.runCollect(
        council(
          [
            { name: "openai", service: openai },
            { name: "google", service: google },
            { name: "anthropic", service: anthropic },
          ],
          history,
        ),
      ),
    )

    const errors = events.filter(
      (e): e is Extract<CouncilEvent, { type: "error" }> => e.type === "error",
    )
    // 1 generate error (openai) + 2 judge errors (openai called as judge by both).
    const generateErrors = errors.filter((e) => e.phase === "generate")
    const judgeErrors = errors.filter((e) => e.phase === "judge")
    expect(generateErrors).toHaveLength(1)
    expect(generateErrors[0]!.member).toBe("openai")
    expect(judgeErrors).toHaveLength(2)
    expect(judgeErrors.every((e) => e.member === "openai")).toBe(true)

    // Only google and anthropic produce candidate_complete; nothing judges openai.
    const completes = events.filter((e) => e.type === "candidate_complete")
    expect(completes).toHaveLength(2)

    const scores = events.filter(
      (e): e is Extract<CouncilEvent, { type: "score" }> => e.type === "score",
    )
    expect(scores).toHaveLength(2)
    expect(new Set(scores.map((s) => `${s.judge}->${s.subject}`))).toEqual(
      new Set(["google->anthropic", "anthropic->google"]),
    )

    // Winner picked from the surviving subjects:
    //   google:    avg(anthropic=8) = 8   <-- winner
    //   anthropic: avg(google=4)    = 4
    const winners = events.filter(
      (e): e is Extract<CouncilEvent, { type: "winner" }> => e.type === "winner",
    )
    expect(winners).toHaveLength(1)
    expect(winners[0]!.member).toBe("google")
    expect(winners[0]!.answer).toBe("from-google")
    expect(winners[0]!.averageScore).toBe(8)
  })

  it("treats malformed score JSON as a judge-phase error, not a silent zero", async () => {
    const { service: openai } = MockProvider.make([
      finalTurn("from-openai"),
      scoreTurn(5, "ok"),
      scoreTurn(5, "ok"),
    ])
    // google emits nonsense for both of its judge turns.
    const { service: google } = MockProvider.make([
      finalTurn("from-google"),
      finalTurn("not json at all"),
      finalTurn("not json at all"),
    ])
    const { service: anthropic } = MockProvider.make([
      finalTurn("from-anthropic"),
      scoreTurn(7, "ok"),
      scoreTurn(7, "ok"),
    ])

    const events = await Effect.runPromise(
      Stream.runCollect(
        council(
          [
            { name: "openai", service: openai },
            { name: "google", service: google },
            { name: "anthropic", service: anthropic },
          ],
          history,
        ),
      ),
    )

    const judgeErrors = events.filter(
      (e): e is Extract<CouncilEvent, { type: "error" }> =>
        e.type === "error" && e.phase === "judge",
    )
    // Both of google's judge responses fail to parse.
    expect(judgeErrors).toHaveLength(2)
    expect(judgeErrors.every((e) => e.member === "google")).toBe(true)
    expect(judgeErrors.every((e) => e.error._tag === "InvalidRequest")).toBe(true)

    // The four well-formed scores from openai + anthropic still land.
    const scores = events.filter((e) => e.type === "score")
    expect(scores).toHaveLength(4)
  })
})
