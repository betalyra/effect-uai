import { describe, expect, it } from "vitest"
import { resolveHost } from "./region.js"

describe("elevenlabs/region.resolveHost", () => {
  it("returns default host when no region or baseUrl", () => {
    expect(resolveHost({})).toBe("https://api.elevenlabs.io/v1")
  })

  it("returns default host for region 'default'", () => {
    expect(resolveHost({ region: "default" })).toBe("https://api.elevenlabs.io/v1")
  })

  it("computes EU residency host for region 'eu'", () => {
    expect(resolveHost({ region: "eu" })).toBe("https://api.eu.residency.elevenlabs.io/v1")
  })

  it("computes IN residency host for region 'in'", () => {
    expect(resolveHost({ region: "in" })).toBe("https://api.in.residency.elevenlabs.io/v1")
  })

  it("passes unknown region through as residency host", () => {
    expect(resolveHost({ region: "ap" })).toBe("https://api.ap.residency.elevenlabs.io/v1")
  })

  it("baseUrl wins over region", () => {
    expect(resolveHost({ baseUrl: "http://localhost:8080/v1", region: "eu" })).toBe(
      "http://localhost:8080/v1",
    )
  })
})
