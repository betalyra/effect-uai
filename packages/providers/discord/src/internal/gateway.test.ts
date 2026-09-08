import { describe, expect, it } from "vitest"
import { classifyClose, closeReason } from "./gateway.js"

describe("classifyClose", () => {
  it("never retries a close reconnecting cannot fix", () => {
    expect([4004, 4010, 4011, 4012, 4013, 4014].map(classifyClose)).toEqual(Array(6).fill("fatal"))
  })

  it("identifies fresh only where the session itself is gone", () => {
    expect([4007, 4009].map(classifyClose)).toEqual(["reidentify", "reidentify"])
  })

  it("resumes on everything else, transport drops included", () => {
    // 1006 is a dropped connection, 4000 the code the zombie check sends.
    expect([4000, 4003, 4005, 4008, 1006, 1011].map(classifyClose)).toEqual(Array(6).fill("resume"))
  })
})

describe("closeReason", () => {
  it("names a fatal code, since Discord's close frames carry no reason", () => {
    expect(closeReason(4014, "")).toContain("privileged intent")
  })

  it("falls back to whatever the socket reported", () => {
    expect(closeReason(1006, "connection reset")).toBe("connection reset")
  })
})
