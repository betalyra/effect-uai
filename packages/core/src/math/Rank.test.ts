import { describe, expect, expectTypeOf, it } from "vitest"
import { type Fused, rrf } from "./Rank.js"

// 1-based rank r in a ranking of weight w contributes w / (k + r).
const contribution = (rank: number, k = 60, weight = 1) => weight / (k + rank)

describe("rrf", () => {
  it("sums contributions across rankings and sorts descending", () => {
    // "b" places 2nd and 1st; "a" places 1st and 3rd; "c" only 2nd.
    const fused = rrf([
      ["a", "b"],
      ["b", "c", "a"],
    ])
    expect(fused.map((f) => f.value)).toEqual(["b", "a", "c"])
    expect(fused[0]?.score).toBeCloseTo(contribution(2) + contribution(1), 12)
    expect(fused[1]?.score).toBeCloseTo(contribution(1) + contribution(3), 12)
    expect(fused[2]?.score).toBeCloseTo(contribution(2), 12)
  })

  it("scores an item present in only one ranking from that ranking alone", () => {
    const fused = rrf([["a"], ["b"]])
    expect(fused.map((f) => f.score)).toEqual([contribution(1), contribution(1)])
  })

  it("k damps the head of each list", () => {
    // At k=1 a rank-1 hit is worth 1/2 and a rank-3 hit 1/4, so the single
    // top placement beats the item that places 2nd twice. At k=60 it loses.
    const rankings = [
      ["a", "b"],
      ["c", "b"],
    ]
    expect(rrf(rankings, { k: 1 })[0]?.value).toBe("b")
    expect(rrf(rankings, { k: 1 })[0]?.score).toBeCloseTo(2 * contribution(2, 1), 12)
    expect(rrf(rankings, { k: 0.5 })[0]?.value).toBe("b")
  })

  it("weights scale each ranking's contribution", () => {
    const fused = rrf([["a"], ["b"]], { weights: [3, 1] })
    expect(fused.map((f) => f.value)).toEqual(["a", "b"])
    expect(fused[0]?.score).toBeCloseTo(contribution(1, 60, 3), 12)
    // A missing weight falls back to 1 rather than dropping the ranking.
    expect(rrf([["a"], ["b"]], { weights: [3] })[1]?.score).toBeCloseTo(contribution(1), 12)
  })

  it("breaks score ties by first-seen order", () => {
    // Both place 1st in one ranking, so scores are identical.
    const fused = rrf([["b"], ["a"]])
    expect(fused[0]?.score).toBe(fused[1]?.score)
    expect(fused.map((f) => f.value)).toEqual(["b", "a"])
  })

  it("returns empty for no rankings and for empty rankings", () => {
    expect(rrf([])).toEqual([])
    expect(rrf([[], []])).toEqual([])
  })

  it("fuses non-string items by Map identity", () => {
    const fused = rrf([
      [1, 2],
      [2, 1],
    ])
    expectTypeOf(fused).toEqualTypeOf<Array<Fused<number>>>()
    expect(fused.map((f) => f.score)).toEqual([
      contribution(1) + contribution(2),
      contribution(2) + contribution(1),
    ])
  })
})
