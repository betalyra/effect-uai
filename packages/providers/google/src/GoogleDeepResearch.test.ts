import { Schema } from "effect"
import * as Turn from "@effect-uai/core/Turn"
import { describe, expect, it } from "vitest"
import { WireInteraction, jobStateOf } from "./GoogleDeepResearch.js"

const decode = Schema.decodeUnknownSync(WireInteraction)

// Extract the `Turn` from a completed interaction the way the service does.
const turnOf = (raw: unknown): Turn.Turn => {
  const state = jobStateOf(decode(raw))
  if (state._tag !== "Succeeded") throw new Error(`expected Succeeded, got ${state._tag}`)
  return state.result
}

describe("GoogleDeepResearch grounding", () => {
  it("maps grounding chunks on a completed interaction to url_citation annotations", () => {
    const turn = turnOf({
      id: "int_1",
      status: "completed",
      outputs: [
        {
          type: "text",
          text: "Report body [1][2].",
          groundingMetadata: {
            groundingChunks: [
              {
                web: {
                  uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
                  title: "example.com",
                },
              },
              { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def" } },
            ],
          },
        },
      ],
    })
    expect(Turn.assistantText(turn)).toBe("Report body [1][2].")
    expect(Turn.citations(turn)).toEqual([
      {
        type: "url_citation",
        url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
        title: "example.com",
      },
      {
        type: "url_citation",
        url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def",
        title: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def",
      },
    ])
  })

  it("gathers and de-dupes grounding across interaction / output / step levels", () => {
    const turn = turnOf({
      id: "int_2",
      status: "completed",
      groundingMetadata: {
        groundingChunks: [{ web: { uri: "https://a.example", title: "a" } }],
      },
      outputs: [{ type: "text", text: "Body." }],
      steps: [
        {
          type: "research",
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://a.example", title: "a" } },
              { web: { uri: "https://b.example", title: "b" } },
            ],
          },
        },
      ],
    })
    expect(Turn.citations(turn).map((c) => c.type === "url_citation" && c.url)).toEqual([
      "https://a.example",
      "https://b.example",
    ])
  })

  it("leaves an ungrounded completed interaction without annotations", () => {
    const turn = turnOf({
      id: "int_3",
      status: "completed",
      outputs: [{ type: "text", text: "Ungrounded report." }],
    })
    expect(Turn.assistantText(turn)).toBe("Ungrounded report.")
    expect(Turn.citations(turn)).toEqual([])
  })
})
