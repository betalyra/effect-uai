import { describe, expect, it } from "@effect/vitest"
import { imageBytes } from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import { Effect } from "effect"
import { itemsToMessages, rejectToolOutputMedia } from "./codec.js"

const output = (parts: Items.ToolCallOutput["output"]): Items.ToolCallOutput => ({
  type: "function_call_output",
  call_id: "c1",
  output: parts,
  isError: true,
})

describe("tool messages", () => {
  it("join text and JSON into the content, JSON serialized once", () => {
    expect(itemsToMessages([output([Items.text("failed:"), Items.json({ code: 404 })])])).toEqual([
      { role: "tool", tool_call_id: "c1", content: 'failed:\n{"code":404}' },
    ])
  })

  it.effect("fail the request when a tool output carries media, instead of dropping it", () =>
    Effect.gen(function* () {
      const history = [
        output([Items.json({ ok: true })]),
        output([Items.image(imageBytes(new Uint8Array([1]), "image/png"))]),
      ]
      const error = yield* Effect.flip(rejectToolOutputMedia("openrouter", history))
      expect(error).toMatchObject({
        _tag: "Unsupported",
        provider: "openrouter",
        capability: "tool_output_media",
      })
      yield* rejectToolOutputMedia("openrouter", history.slice(0, 1))
    }),
  )
})
