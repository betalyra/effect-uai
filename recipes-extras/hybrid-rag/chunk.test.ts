import { describe, expect, it } from "vitest"
import { chunk, sentences } from "./chunk.js"
import { stripGutenberg } from "./corpus.js"

const sentence = (n: number) => `This is sentence number ${n} and it runs on for a little while.`
const many = (n: number) => Array.from({ length: n }, (_, i) => sentence(i + 1)).join(" ")

describe("sentences", () => {
  it("splits on terminators and rejoins hard-wrapped lines", () => {
    expect(sentences("One thing.\nStill one thing.\n\nA new para.")).toEqual([
      "One thing.",
      "Still one thing.",
      "A new para.",
    ])
  })
})

describe("chunk", () => {
  it("never splits mid-sentence", () => {
    const chunks = chunk(many(80), { targetTokens: 32 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c).toMatch(/\.$/)
  })

  it("repeats the tail of each chunk at the start of the next", () => {
    const chunks = chunk(many(40), { targetTokens: 32, overlapSentences: 2 })
    for (let i = 1; i < chunks.length; i++) {
      const previous = sentences(chunks[i - 1]!)
      const current = sentences(chunks[i]!)
      expect(current.slice(0, 2)).toEqual(previous.slice(-2))
    }
  })

  it("does not repeat an oversized sentence forever", () => {
    // One sentence longer than the whole target: it must appear once, not in
    // every chunk after it.
    const huge = `${"word ".repeat(500)}end.`
    const chunks = chunk(`${huge} ${many(10)}`, { targetTokens: 32 })
    expect(chunks.filter((c) => c.includes("end.")).length).toBe(1)
  })

  it("returns one chunk for text under the target", () => {
    expect(chunk(many(2), { targetTokens: 512 })).toHaveLength(1)
  })
})

describe("stripGutenberg", () => {
  it("keeps only the text between the markers", () => {
    const raw = [
      "The Project Gutenberg eBook of Something",
      "license boilerplate nobody wants indexed",
      "*** START OF THE PROJECT GUTENBERG EBOOK SOMETHING ***",
      "The actual book.",
      "*** END OF THE PROJECT GUTENBERG EBOOK SOMETHING ***",
      "more boilerplate, donation instructions",
    ].join("\n")
    expect(stripGutenberg(raw)).toBe("The actual book.")
  })

  it("passes through text without markers", () => {
    expect(stripGutenberg("  just a document.  ")).toBe("just a document.")
  })
})
