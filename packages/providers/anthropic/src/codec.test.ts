import { fileBase64, fileUrl } from "@effect-uai/core/File"
import { imageBytes } from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import { Option, Result } from "effect"
import { describe, expect, it } from "vitest"
import { buildRequestBody } from "./codec.js"

const toolResultFor = (output: Items.ToolCallOutput) => {
  const body = Result.getOrThrow(
    buildRequestBody({
      model: "claude-sonnet-4-5",
      history: [
        Items.userText("go"),
        { type: "function_call", call_id: "c1", name: "shot", arguments: "{}" },
        output,
      ],
      maxTokens: 1024,
      temperature: Option.none(),
      topP: Option.none(),
      topK: Option.none(),
      stopSequences: Option.none(),
      thinking: Option.none(),
      tools: Option.none(),
      toolChoice: Option.none(),
      userId: Option.none(),
      outputConfig: Option.none(),
      cacheControl: Option.none(),
    }),
  )
  return body.messages.at(-1)?.content
}

const outputOf = (output: Items.ToolCallOutput["output"], isError?: boolean) =>
  toolResultFor({
    type: "function_call_output",
    call_id: "c1",
    output,
    ...(isError !== undefined && { isError }),
  })

describe("tool_result", () => {
  it("sends text and JSON as one string and flags failures with is_error", () => {
    expect(outputOf([Items.json({ _tag: "CityNotFound", city: "Atlantis" })], true)).toEqual([
      {
        type: "tool_result",
        tool_use_id: "c1",
        content: '{"_tag":"CityNotFound","city":"Atlantis"}',
        is_error: true,
      },
    ])
  })

  it("sends media as image and document blocks, the filename as the document title", () => {
    expect(
      outputOf([
        Items.text("Home"),
        Items.image(imageBytes(new Uint8Array([1, 2, 3]), "image/png")),
        Items.file(fileBase64("JVBE", "application/pdf"), "report.pdf"),
        Items.file(fileUrl("https://x/a.pdf")),
      ]),
    ).toEqual([
      {
        type: "tool_result",
        tool_use_id: "c1",
        content: [
          { type: "text", text: "Home" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBE" },
            title: "report.pdf",
          },
          { type: "document", source: { type: "url", url: "https://x/a.pdf" } },
        ],
      },
    ])
  })
})
