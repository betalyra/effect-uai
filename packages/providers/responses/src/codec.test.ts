import { fileBase64, fileUrl } from "@effect-uai/core/File"
import { imageBytes } from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import type { HistoryItem } from "@effect-uai/core/Items"
import { describe, expect, it } from "vitest"
import { itemsToInput, wireItemToItem } from "./codec.js"

describe("providerData round-trip", () => {
  it("re-emits a stashed item verbatim, preserving fields our shape drops", () => {
    // `id` and `encrypted_content` cannot be reconstructed from a Reasoning
    // item, so the round-trip has to go through the stash.
    const items = wireItemToItem({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque-state",
    })
    expect(itemsToInput(items)).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque-state" },
    ])
  })
})

describe("providerData is a shared slot", () => {
  // Regression: the passthrough used to re-emit the whole `providerData`
  // object as the wire item. An item that had been through another provider
  // first was sent as that provider's data, losing the real content.
  it("ignores another provider's data and encodes the item normally", () => {
    const history: ReadonlyArray<HistoryItem> = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello world" }],
        providerData: { gemini: { thoughtSignature: "sig-abc" } },
      },
    ]
    expect(itemsToInput(history)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello world" }] },
    ])
  })

  it("does not send a foreign function_call as junk", () => {
    const history: ReadonlyArray<HistoryItem> = [
      {
        type: "function_call",
        call_id: "c1",
        name: "get_weather",
        arguments: '{"city":"Lisbon"}',
        providerData: { gemini: { id: "g1", thoughtSignature: "sig-abc" } },
      },
    ]
    expect(itemsToInput(history)).toEqual([
      {
        type: "function_call",
        call_id: "c1",
        name: "get_weather",
        arguments: '{"city":"Lisbon"}',
      },
    ])
  })

  it("re-emits only our key when an item carries several providers' data", () => {
    const history: ReadonlyArray<HistoryItem> = [
      {
        type: "reasoning",
        signature: "opaque-state",
        providerData: {
          responses: { type: "reasoning", id: "rs_1", encrypted_content: "opaque-state" },
          gemini: { thoughtSignature: "sig-abc" },
        },
      },
    ]
    expect(itemsToInput(history)).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque-state" },
    ])
  })

  it("falls back to a normal encode when the stashed value is not one of ours", () => {
    const history: ReadonlyArray<HistoryItem> = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
        providerData: { responses: { type: "not_an_item_we_model" } },
      },
    ]
    expect(itemsToInput(history)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ])
  })
})

describe("tool output", () => {
  const output = (parts: Items.ToolCallOutput["output"], isError?: boolean) =>
    itemsToInput([
      {
        type: "function_call_output",
        call_id: "c1",
        output: parts,
        ...(isError !== undefined && { isError }),
      },
    ])

  it("sends text and JSON as one string, JSON serialized once", () => {
    expect(
      output([Items.text("found 2"), Items.json({ hits: [1, 2], note: 'a "quote"' })], true),
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "c1",
        output: 'found 2\n{"hits":[1,2],"note":"a \\"quote\\""}',
      },
    ])
  })

  it("sends media as native parts: images as image_url, files as file_data or file_url", () => {
    expect(
      output([
        Items.json({ title: "Home" }),
        Items.image(imageBytes(new Uint8Array([1, 2, 3]), "image/png")),
        Items.file(fileBase64("JVBE", "application/pdf"), "report.pdf"),
        Items.file(fileUrl("https://x/a.pdf")),
      ]),
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: '{"title":"Home"}' },
          { type: "input_image", image_url: "data:image/png;base64,AQID" },
          {
            type: "input_file",
            file_data: "data:application/pdf;base64,JVBE",
            filename: "report.pdf",
          },
          { type: "input_file", file_url: "https://x/a.pdf" },
        ],
      },
    ])
  })
})
