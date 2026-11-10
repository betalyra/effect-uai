import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema, SchemaTransformation } from "effect"
import { imageBytes } from "../domain/Image.js"
import * as Content from "./Content.js"
import * as ToolOutput from "./ToolOutput.js"

const call = { call_id: "c1" }
const png = Content.image(imageBytes(new Uint8Array([1, 2, 3]), "image/png"))

describe("ToolOutput.success", () => {
  it.effect("splits only top-level media: text, JSON and arrays without media stay one part", () =>
    Effect.gen(function* () {
      const outputs = yield* Effect.forEach(["hello", { hits: [1, 2] }, [1, 2], png], (value) =>
        ToolOutput.make(call, value),
      )
      expect(outputs.map((o) => o.output.map((p) => p.type))).toEqual([
        ["input_text"],
        ["input_json"],
        ["input_json"],
        ["input_image"],
      ])
    }),
  )

  it.effect("takes JSON from the schema's encoded side and media from the value", () =>
    Effect.gen(function* () {
      const Shot = Schema.Tuple([
        Schema.Struct({ title: Schema.String, at: Schema.DateFromString }),
        Content.Image,
      ])
      const value = [{ title: "Home", at: new Date("2026-01-01T00:00:00.000Z") }, png] as const

      const out = yield* ToolOutput.success(call, Shot, value)
      expect(out.output).toEqual([
        { type: "input_json", value: { title: "Home", at: "2026-01-01T00:00:00.000Z" } },
        { type: "input_image", source: png.source },
      ])
      expect(out.isError).toBeUndefined()

      const back = yield* ToolOutput.encoded(out.output).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Shot)),
      )
      expect(back).toEqual(value)
    }),
  )

  it.effect("keeps the JSON whole when the schema encodes a mixed array to another shape", () =>
    Effect.gen(function* () {
      const Encoded = Schema.Struct({
        title: Schema.String,
        shot: Schema.toEncoded(Content.Image),
      })
      const Reshaped = Encoded.pipe(
        Schema.decodeTo(
          Schema.Tuple([Schema.String, Content.Image]),
          SchemaTransformation.transform({
            decode: ({ title, shot }) => [title, shot] as const,
            encode: ([title, shot]) => ({ title, shot }),
          }),
        ),
      )
      const out = yield* ToolOutput.success(call, Reshaped, ["Home", png] as const)
      expect(out.output).toHaveLength(1)
      expect(out.output[0]).toMatchObject({
        type: "input_json",
        value: { title: "Home", shot: { _tag: "Image" } },
      })
    }),
  )
})

describe("ToolOutput.failure", () => {
  it.effect("encodes the error as JSON and flags the output", () =>
    Effect.gen(function* () {
      const out = yield* ToolOutput.failure(
        call,
        ToolOutput.RunError,
        new ToolOutput.UnknownTool({ message: "no tool named nope" }),
      )
      expect(out).toEqual({
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_json", value: { _tag: "UnknownTool", message: "no tool named nope" } },
        ],
        isError: true,
      })
    }),
  )
})

describe("ToolOutput.value", () => {
  it.effect("reads parts back as the value that made them, media as classes", () =>
    Effect.gen(function* () {
      const value = [{ title: "Home" }, png, "caption"]
      const out = yield* ToolOutput.make(call, value)
      expect(out.output.map((p) => p.type)).toEqual(["input_json", "input_image", "input_text"])
      const back = ToolOutput.value(out.output)
      expect(back).toEqual(value)
      expect(Array.isArray(back) && back[1]).toBeInstanceOf(Content.Image)
    }),
  )
})

describe("ToolOutput.ValueParts", () => {
  const encode = Schema.encodeEffect(ToolOutput.ValueParts)
  const decode = Schema.decodeUnknownEffect(ToolOutput.ValueParts)

  it.effect("JSON shaped like an image stays JSON through the wire", () =>
    Effect.gen(function* () {
      const lookalike = { _tag: "Image", source: { _tag: "url", url: "https://x/cat.png" } }
      const wire = yield* encode(lookalike)
      expect(wire).toEqual([{ type: "input_json", value: lookalike }])
      const back = yield* decode(JSON.parse(JSON.stringify(wire)))
      expect(back).toEqual(lookalike)
      expect(back).not.toBeInstanceOf(Content.Image)
    }),
  )

  it.effect("media round-trips as a class, bytes as base64 on the wire", () =>
    Effect.gen(function* () {
      const value = [{ title: "Home" }, png, "caption"]
      const wire = yield* encode(value)
      expect(wire[1]).toEqual({
        type: "input_image",
        source: { _tag: "bytes", bytes: "AQID", mimeType: "image/png" },
      })
      const back = yield* decode(JSON.parse(JSON.stringify(wire)))
      expect(back).toEqual(value)
    }),
  )
})
