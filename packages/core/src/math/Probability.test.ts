import { describe, expect, it } from "vitest"
import { confidence, margin } from "./Probability.js"

describe("confidence", () => {
  it("is 1 when all mass sits on one outcome", () => {
    expect(confidence([1, 0, 0])).toBeCloseTo(1, 10)
  })

  it("is 0 when mass is spread evenly, at any length", () => {
    expect(confidence([0.5, 0.5])).toBeCloseTo(0, 10)
    expect(confidence([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0, 10)
  })

  it("is 1 for fewer than two outcomes, which have nothing to be uncertain between", () => {
    expect(confidence([])).toBe(1)
    expect(confidence([1])).toBe(1)
  })

  it("rises as mass concentrates", () => {
    const spread = confidence([0.4, 0.35, 0.25])
    const leaning = confidence([0.6, 0.25, 0.15])
    const decided = confidence([0.9, 0.07, 0.03])
    expect(spread).toBeLessThan(leaning)
    expect(leaning).toBeLessThan(decided)
  })

  it("is conservative on two outcomes, so a threshold does not transfer across lengths", () => {
    expect(confidence([0.94, 0.06])).toBeCloseTo(0.67, 2)
  })
})

describe("margin", () => {
  it("is the gap between the top two, whatever order they arrive in", () => {
    expect(margin([0.6, 0.3, 0.1])).toBeCloseTo(0.3, 10)
    expect(margin([0.1, 0.6, 0.3])).toBeCloseTo(0.3, 10)
  })

  it("is 0 on a tie and 0 when empty", () => {
    expect(margin([0.5, 0.5])).toBeCloseTo(0, 10)
    expect(margin([])).toBe(0)
  })

  it("yields the lone probability for a single outcome", () => {
    expect(margin([0.7])).toBeCloseTo(0.7, 10)
  })
})

describe("confidence and margin disagree, which is why both exist", () => {
  // Two plausible answers versus no idea. Same winner, same top mass.
  const closeSecond = [0.45, 0.42, 0.13]
  const flatSpread = [0.45, 0.11, 0.11, 0.11, 0.11, 0.11]

  it("confidence cannot separate them", () => {
    expect(Math.abs(confidence(closeSecond) - confidence(flatSpread))).toBeLessThan(0.05)
  })

  it("margin separates them sharply", () => {
    expect(margin(closeSecond)).toBeCloseTo(0.03, 10)
    expect(margin(flatSpread)).toBeCloseTo(0.34, 10)
  })
})
