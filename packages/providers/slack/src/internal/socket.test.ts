import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { classifyDisconnect, remember } from "./socket.js"

describe("classifyDisconnect", () => {
  it("ends only on the reason Slack says not to retry", () => {
    expect(classifyDisconnect("link_disabled")).toBe("fatal")
    // A rolling refresh is scheduled, so it reopens without backing off.
    expect(["refresh_requested", "warning"].map(classifyDisconnect)).toEqual(["refresh", "refresh"])
    expect(classifyDisconnect(undefined)).toBe("reconnect")
  })
})

describe("remember", () => {
  it("drops a redelivery of an id still in the set", () => {
    const seen = Option.getOrThrow(remember([], "Ev1"))
    expect(remember(seen, "Ev1")).toEqual(Option.none())
    expect(Option.getOrThrow(remember(seen, "Ev2"))).toEqual(["Ev1", "Ev2"])
  })

  it("forgets the oldest once the set is full, so it cannot grow without bound", () => {
    const full = ["a", "b"]
    expect(Option.getOrThrow(remember(full, "c", 2))).toEqual(["b", "c"])
  })
})
