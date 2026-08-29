import { Array as Arr, Effect, Layer } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { chunk as chunkFromTag, Chunker } from "@effect-uai/core/Chunker"
import { Tokenizer } from "@effect-uai/core/Tokenizer"
import {
  type Chunk,
  fixed,
  layer,
  markdown,
  recursive,
  sentences,
  withTokenizer,
} from "./Chunking.js"

const PROSE = `The Adventure of the Speckled Band

On glancing over my notes of the seventy odd cases in which I have during
the last eight years studied the methods of my friend Sherlock Holmes, I
find many tragic, some comic, a large number merely strange, but none
commonplace.

It was early in April in the year '83 that I woke one morning to find
Sherlock Holmes standing, fully dressed, by the side of my bed. He was a
late riser, as a rule, and as the clock on the mantelpiece showed me that
it was only a quarter-past seven, I blinked up at him in some surprise.

"Very sorry to knock you up, Watson," said he, "but it's the common lot
this morning. Mrs. Hudson has been knocked up, she retorted upon me, and
I on you."`

const MARKDOWN = `Intro paragraph before any heading.

# Install

Run the installer.

\`\`\`sh
# this comment is not a heading
pnpm add example
\`\`\`

## Usage

Call the thing.

# License

MIT.`

const consecutive = <A>(xs: ReadonlyArray<A>): ReadonlyArray<readonly [A, A]> =>
  Arr.zip(xs, Arr.drop(xs, 1))

/** The invariant every chunker owes its caller: offsets reproduce the text. */
const expectProvenance = (input: string, chunks: ReadonlyArray<Chunk>) => {
  expect(chunks.length).toBeGreaterThan(0)
  expect(Arr.map(chunks, (c) => input.slice(c.start, c.end))).toEqual(
    Arr.map(chunks, (c) => c.text),
  )
  expect(Arr.filter(chunks, (c) => c.end <= c.start)).toEqual([])
}

describe.each([
  ["fixed", fixed],
  ["recursive", recursive],
  ["sentences", sentences],
  ["markdown", markdown],
])("%s", (_name, chunker) => {
  it("reproduces every chunk from the offsets it reports", () => {
    expectProvenance(PROSE, chunker(PROSE, { targetSize: 40 }))
    expectProvenance(MARKDOWN, chunker(MARKDOWN, { targetSize: 40 }))
  })

  it("covers the input in order, leaving no content behind", () => {
    const chunks = chunker(PROSE, { targetSize: 40 })
    expect(chunks[0]!.start).toBe(PROSE.indexOf("The"))
    expect(chunks.at(-1)!.end).toBe(PROSE.trimEnd().length)
    expect(Arr.filter(consecutive(chunks), ([a, b]) => b.start <= a.start)).toEqual([])
  })

  it("returns nothing for blank input", () => {
    expect(chunker("")).toEqual([])
    expect(chunker("  \n\n \t ")).toEqual([])
  })

  it("advances under heavy overlap instead of repeating a chunk", () => {
    // 75% overlap is where a naive carry loops forever, and an unsplittable
    // run is where it has nothing smaller to fall back on.
    const inputs = [PROSE, MARKDOWN, `Short one. ${"x".repeat(400)} End.`]
    const stalled = Arr.flatMap(inputs, (input) =>
      Arr.filter(
        consecutive(chunker(input, { targetSize: 20, overlap: 15 })),
        ([a, b]) => b.end <= a.end,
      ),
    )
    expect(stalled).toEqual([])
  })
})

describe("recursive", () => {
  it("keeps chunks under the target when the text can be divided", () => {
    const oversized = Arr.filter(
      recursive(PROSE, { targetSize: 40 }),
      (c) => Math.ceil(c.text.length / 4) > 40,
    )
    expect(oversized).toEqual([])
  })

  it("prefers coarse separators, so every break lands on a paragraph boundary", () => {
    const chunks = recursive(PROSE, { targetSize: 120 })
    expect(chunks.length).toBeGreaterThan(1)
    const midParagraph = Arr.filter(
      Arr.drop(chunks, 1),
      (c) => !/\n\s*\n\s*$/u.test(PROSE.slice(0, c.start)),
    )
    expect(midParagraph).toEqual([])
  })

  it("falls back to blind windows when nothing divides the text", () => {
    const unbroken = "x".repeat(500)
    const chunks = recursive(unbroken, { targetSize: 25 })
    expect(chunks.length).toBeGreaterThan(4)
    expectProvenance(unbroken, chunks)
  })
})

describe("sentences", () => {
  const FOUR = "One fish. Two fish! Red fish? Blue fish."

  it("keeps each sentence whole", () => {
    expect(Arr.map(sentences(FOUR, { targetSize: 3 }), (c) => c.text)).toEqual([
      "One fish.",
      "Two fish!",
      "Red fish?",
      "Blue fish.",
    ])
  })

  it("packs as many sentences as fit", () => {
    expect(Arr.map(sentences(FOUR, { targetSize: 6 }), (c) => c.text)).toEqual([
      "One fish. Two fish!",
      "Red fish? Blue fish.",
    ])
  })

  it("repeats the trailing sentence when overlap allows one", () => {
    expect(Arr.map(sentences(FOUR, { targetSize: 6, overlap: 3 }), (c) => c.text)).toEqual([
      "One fish. Two fish!",
      "Two fish! Red fish?",
      "Red fish? Blue fish.",
    ])
  })

  it("cuts a sentence that exceeds the target on its own", () => {
    const long = `Short one. ${"word ".repeat(60)}end. Another short one.`
    const chunks = sentences(long, { targetSize: 20 })
    expect(chunks.length).toBeGreaterThan(3)
    expect(Arr.filter(chunks, (c) => Math.ceil(c.text.length / 4) > 20)).toEqual([])
  })
})

describe("markdown", () => {
  it("starts a chunk at every heading, keeping the heading with its prose", () => {
    const chunks = markdown(MARKDOWN, { targetSize: 512 })
    expect(Arr.map(chunks, (c) => c.text.split("\n")[0])).toEqual([
      "Intro paragraph before any heading.",
      "# Install",
      "## Usage",
      "# License",
    ])
    expect(chunks[1]!.text).toContain("Run the installer.")
  })

  it("ignores a heading inside a fenced code block", () => {
    expect(markdown(MARKDOWN, { targetSize: 512 })[1]!.text).toContain(
      "# this comment is not a heading",
    )
  })

  it("splits an oversized section without spanning the next one", () => {
    const chunks = markdown(MARKDOWN, { targetSize: 10 })
    expect(chunks.length).toBeGreaterThan(4)
    const spanning = Arr.filter(chunks, (c) => c.text.split(/^#{1,6} /mu).length > 2)
    expect(spanning).toEqual([])
  })
})

describe("fixed", () => {
  it("cuts blind windows at the calibrated budget", () => {
    const chunks = fixed(PROSE, { targetSize: 25 })
    // targetSize 25 at the default chars/4 measure is a 100-character window.
    expect(chunks[0]!.text).toHaveLength(100)
    expect(chunks[0]!.end).toBe(chunks[1]!.start)
  })

  it("overlaps consecutive windows", () => {
    const chunks = fixed(PROSE, { targetSize: 25, overlap: 5 })
    expect(chunks[1]!.start).toBe(chunks[0]!.start + 80)
  })
})

// Two ids per word, so a token measure and the chars/4 default disagree.
const stubTokenizer = Layer.succeed(Tokenizer, {
  encode: (text: string) => Arr.flatMap(text.split(/\s+/u), (w) => (w === "" ? [] : [1, 2])),
  decode: () => "",
})

describe("withTokenizer", () => {
  it("sizes chunks by the tokenizer instead of the character estimate", () => {
    const chunks = Effect.runSync(
      withTokenizer(sentences)(PROSE, { targetSize: 20 }).pipe(Effect.provide(stubTokenizer)),
    )
    expectProvenance(PROSE, chunks)
    // A multi-sentence chunk must respect the budget: 2 tokens per word.
    const overBudget = Arr.filter(
      chunks,
      (c) =>
        c.text.split(/[.!?]/u).length > 2 &&
        Arr.filter(c.text.split(/\s+/u), (w) => w !== "").length * 2 > 20,
    )
    expect(overBudget).toEqual([])
  })
})

describe("layer", () => {
  it("serves a chunker through the core Chunker tag", () => {
    const chunks = Effect.runSync(
      chunkFromTag(PROSE).pipe(Effect.provide(layer(recursive, { targetSize: 120 }))),
    )
    expectTypeOf(chunks).toEqualTypeOf<ReadonlyArray<Chunk>>()
    expect(chunks).toEqual(recursive(PROSE, { targetSize: 120 }))
    expectTypeOf(layer(recursive)).toEqualTypeOf<Layer.Layer<Chunker>>()
  })
})
