import * as ToolDecision from "@effect-uai/core/ToolDecision"
import * as Image from "@effect-uai/core/Image"
import { describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Input from "./Input.js"
import { InputId } from "./RunEvent.js"

const ChatInput = Input.make(Schema.Struct({ templateId: Schema.String }))
const Body = Schema.fromJsonString(ChatInput.InputJson)

describe("Input wire codec", () => {
  it.effect("carries image bytes and typed data through a JSON body", () =>
    Effect.gen(function* () {
      const draft = Input.submit(
        [
          Input.user("What is in this picture?", [
            {
              type: "input_image",
              source: Image.imageBytes(new Uint8Array([1, 2, 3]), "image/png"),
            },
          ]),
          Input.user("Answer in one sentence."),
        ],
        { data: { templateId: "describe" } },
      )
      const input = { ...draft, id: InputId.make("in_1") }
      const body = yield* Schema.encodeEffect(Body)(input)
      expect(yield* Schema.decodeUnknownEffect(Body)(body)).toEqual(input)
    }),
  )

  it.effect("rejects a submit whose data does not match the app schema", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({ ...Input.submit("Hi"), data: { templateId: 42 } })
      const exit = yield* Effect.exit(Schema.decodeUnknownEffect(Body)(body))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("carries the app's own decisions and rejects one it doesn't define", () =>
    Effect.gen(function* () {
      const Decisions = ToolDecision.make({
        Approve: { always: Schema.optionalKey(Schema.Boolean) },
        Respond: { output: Schema.Json },
      })
      const Booking = Input.make(Schema.Struct({}), Decisions.schema)
      const Resolve = Schema.fromJsonString(Booking.InputJson)
      const input = {
        ...Input.resolve([
          { callId: "c1", decision: Decisions.Approve({ always: true }) },
          { callId: "c2", decision: Decisions.Respond({ output: { booked: true } }) },
        ]),
        id: InputId.make("in_1"),
      }
      const body = yield* Schema.encodeEffect(Resolve)(input)
      expect(yield* Schema.decodeUnknownEffect(Resolve)(body)).toEqual(input)

      const denied = JSON.stringify({
        ...input,
        decisions: [{ callId: "c1", decision: { _tag: "Deny" } }],
      })
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(Resolve)(denied)))).toBe(
        true,
      )
    }),
  )
})
