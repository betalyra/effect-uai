import { fileUrl } from "@effect-uai/core/File"
import { imageBytes } from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  WireChunk,
  accumulatorToTurn,
  continuationOf,
  emptyAccumulator,
  functionResponseBody,
  ingestChunk,
} from "./codec.js"

const body = (output: Items.ToolCallOutput["output"], isError?: boolean) =>
  functionResponseBody({
    type: "function_call_output",
    call_id: "c1",
    output,
    ...(isError !== undefined && { isError }),
  })

describe("functionResponseBody", () => {
  it("puts one JSON value under output as an object, never a string", () => {
    expect(body([Items.json({ city: "Lisbon", temp: 18 })])).toEqual({
      response: { output: { city: "Lisbon", temp: 18 } },
    })
  })

  it("puts a failure under error", () => {
    expect(body([Items.json({ _tag: "CityNotFound", city: "Atlantis" })], true)).toEqual({
      response: { error: { _tag: "CityNotFound", city: "Atlantis" } },
    })
  })

  it("keeps several values as an array and moves media to parts", () => {
    expect(
      body([
        Items.text("Home"),
        Items.json({ hits: 2 }),
        Items.image(imageBytes(new Uint8Array([1, 2, 3]), "image/png")),
        Items.file(fileUrl("gs://bucket/a.pdf", "application/pdf"), "a.pdf"),
      ]),
    ).toEqual({
      response: { output: ["Home", { hits: 2 }] },
      parts: [
        { inlineData: { mimeType: "image/png", data: "AQID" } },
        {
          fileData: {
            fileUri: "gs://bucket/a.pdf",
            mimeType: "application/pdf",
            displayName: "a.pdf",
          },
        },
      ],
    })
  })

  it("sends an empty response for media-only output", () => {
    expect(body([Items.image(imageBytes(new Uint8Array([1]), "image/png"))]).response).toEqual({})
  })
})

describe("long decode", () => {
  const turnOf = (chunks: ReadonlyArray<unknown>) =>
    accumulatorToTurn(
      chunks
        .map((chunk) => Schema.decodeUnknownSync(WireChunk)(chunk))
        .reduce((acc, chunk) => ingestChunk(acc, chunk).accumulator, emptyAccumulator),
    )
  const text = (t: string) => ({ content: { role: "model", parts: [{ text: t }] } })

  it("reads a cut at Gemini's cap as max_tokens, keeping the final token", () => {
    const turn = turnOf([
      { candidates: [{ ...text("Chapter one…"), continuationToken: "checkpoint" }] },
      { candidates: [{ ...text("…"), finishReason: "CONTINUATION", continuationToken: "hop-2" }] },
    ])
    expect(turn.stop_reason).toBe("max_tokens")
    expect(continuationOf(turn)).toEqual(Option.some("hop-2"))
  })

  it("offers no continuation once the answer finished, despite a checkpoint token", () => {
    const turn = turnOf([
      { candidates: [{ ...text("Done."), continuationToken: "checkpoint" }] },
      { candidates: [{ ...text(""), finishReason: "STOP" }] },
    ])
    expect(turn.stop_reason).toBe("stop")
    expect(continuationOf(turn)).toEqual(Option.none())
  })
})
