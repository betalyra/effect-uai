import { fileUrl } from "@effect-uai/core/File"
import { imageBytes } from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import { describe, expect, it } from "vitest"
import { functionResponseBody } from "./codec.js"

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
