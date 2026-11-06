import { describe, it } from "@effect/vitest"
import { Option } from "effect"
import { expect } from "vitest"
import * as Encoding from "./Encoding.js"

describe("Encoding.lastEventId", () => {
  it.each([
    { label: "web Headers", headers: new Headers({ "last-event-id": "9" }), seq: Option.some(9) },
    { label: "Effect record headers", headers: { "last-event-id": "7" }, seq: Option.some(7) },
    { label: "no header", headers: new Headers(), seq: Option.none() },
    { label: "a non-integer value", headers: { "last-event-id": "abc" }, seq: Option.none() },
  ])("reads $label", ({ headers, seq }) => {
    expect(Encoding.lastEventId(headers)).toEqual(seq)
  })
})
