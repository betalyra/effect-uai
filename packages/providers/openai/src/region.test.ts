import { describe, expect, it } from "vitest"
import { resolveHost } from "./region.js"

describe("openai/region.resolveHost", () => {
  it("returns default host when no region or baseUrl", () => {
    expect(resolveHost({})).toBe("https://api.openai.com/v1")
  })

  it("returns default host for region 'default'", () => {
    expect(resolveHost({ region: "default" })).toBe("https://api.openai.com/v1")
  })

  it("computes EU host for region 'eu'", () => {
    expect(resolveHost({ region: "eu" })).toBe("https://eu.api.openai.com/v1")
  })

  it("passes unknown region through as host prefix", () => {
    expect(resolveHost({ region: "apac" })).toBe("https://apac.api.openai.com/v1")
  })

  it("baseUrl wins over region", () => {
    expect(resolveHost({ baseUrl: "http://localhost:8080/v1", region: "eu" })).toBe(
      "http://localhost:8080/v1",
    )
  })
})
