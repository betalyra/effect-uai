import { Context, Effect } from "effect"
import type * as AiError from "../domain/AiError.js"

/**
 * A passage of a document, with the character offsets it came from.
 *
 * Implementor contract: `text` is the input's `[start, end)` slice verbatim,
 * so a retrieved passage can be traced back to its source and enriched with
 * what surrounds it. Chunks may overlap.
 */
export type Chunk = {
  readonly text: string
  readonly start: number
  readonly end: number
}

/**
 * Splitting a document into retrievable passages. Strategy and sizing are
 * fixed when the layer is built, so callers stay portable across a local
 * splitter and a hosted chunking service.
 */
export type ChunkerService = {
  readonly chunk: (text: string) => Effect.Effect<ReadonlyArray<Chunk>, AiError.AiError>
}

export class Chunker extends Context.Service<Chunker, ChunkerService>()(
  "@betalyra/effect-uai/Chunker",
) {}

/** Split a document into passages. */
export const chunk = (
  text: string,
): Effect.Effect<ReadonlyArray<Chunk>, AiError.AiError, Chunker> =>
  Effect.flatMap(Chunker, (chunker) => chunker.chunk(text))
