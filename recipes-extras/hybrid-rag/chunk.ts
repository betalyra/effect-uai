/**
 * One implementation of the `Chunker` port: a plain sentence-boundary
 * splitter with overlap. Swap it for a semantic chunker or a chunking service
 * without touching `recipe.ts`.
 */
import { Array as Arr, Effect, Layer, pipe } from "effect"
import { Chunker } from "./recipe.js"

// Close enough to size chunks without pulling in a tokenizer.
const CHARS_PER_TOKEN = 4

export type ChunkOptions = {
  /** Target chunk size in approximate tokens. Default 512. */
  readonly targetTokens?: number
  /** Sentences repeated at the start of the next chunk. Default 2. */
  readonly overlapSentences?: number
}

/** Split on sentence-ending punctuation. A blank line is always a break. */
export const sentences = (text: string): ReadonlyArray<string> =>
  pipe(
    text.split(/\n\s*\n/),
    Arr.flatMap((paragraph) => paragraph.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)),
    Arr.map((s) => s.trim()),
    Arr.filter((s) => s.length > 0),
  )

export const chunk = (text: string, options: ChunkOptions = {}): ReadonlyArray<string> => {
  const targetChars = (options.targetTokens ?? 512) * CHARS_PER_TOKEN
  const overlap = options.overlapSentences ?? 2

  const final = Arr.reduce(
    sentences(text),
    { chunks: [] as ReadonlyArray<string>, current: [] as ReadonlyArray<string> },
    (acc, sentence) => {
      const current = [...acc.current, sentence]
      if (current.join(" ").length < targetChars) return { chunks: acc.chunks, current }
      // Carry at most `overlap` sentences and never the whole chunk, so a
      // single oversized sentence cannot repeat in every chunk after it.
      return {
        chunks: [...acc.chunks, current.join(" ")],
        current: Arr.takeRight(Arr.drop(current, 1), overlap),
      }
    },
  )

  return final.current.length > 0 ? [...final.chunks, final.current.join(" ")] : final.chunks
}

export const layer = (options: ChunkOptions = {}): Layer.Layer<Chunker> =>
  Layer.succeed(Chunker, { split: (text) => Effect.succeed(chunk(text, options)) })
