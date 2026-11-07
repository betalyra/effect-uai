import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { imageBytes } from "../domain/Image.js"
import * as Content from "./Content.js"

const bytes = new Uint8Array([137, 80, 78, 71])
const encode = Schema.encodeUnknownEffect(Content.Value)
const decode = Schema.decodeUnknownEffect(Content.Value)

describe("Content.Value", () => {
  it("encodes to JSON", () => {
    expectTypeOf<typeof Content.Value.Encoded>().toExtend<Schema.Json>()
  })

  it.effect("round-trips image bytes through JSON as base64", () =>
    Effect.gen(function* () {
      const encoded = yield* encode(Content.image(imageBytes(bytes, "image/png")))
      expect(encoded).toEqual({
        _tag: "Image",
        source: { _tag: "bytes", bytes: "iVBORw==", mimeType: "image/png" },
      })

      const decoded = yield* decode(JSON.parse(JSON.stringify(encoded)))
      expect(decoded).toBeInstanceOf(Content.Image)
      expect(decoded).toEqual(Content.image(imageBytes(bytes, "image/png")))
    }),
  )

  it.effect("keeps plain objects plain and media as classes in a mixed array", () =>
    Effect.gen(function* () {
      const value = [
        { title: "Home" },
        Content.file({ _tag: "url", url: "https://x/a.pdf" }, "a.pdf"),
      ]
      const decoded = yield* decode(yield* encode(value))
      expect(decoded).toEqual(value)
      expect(Array.isArray(decoded) && decoded.map(Content.isMedia)).toEqual([false, true])
    }),
  )
})
