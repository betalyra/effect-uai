import { Context } from "effect"

/**
 * Turning text into tokens, for sizing chunks, budgeting context, and
 * estimating usage a provider does not report. Count with `encode(text).length`.
 *
 * Implementor contract: both methods are synchronous, so counting inside a loop
 * never awaits; loading a vocabulary is the layer's job. `decode` inverts
 * `encode`. Implement this only over a real vocabulary, never a heuristic:
 * a character-count estimate is a plain function, not a service.
 */
export type TokenizerService = {
  readonly encode: (text: string) => ReadonlyArray<number>
  readonly decode: (tokens: ReadonlyArray<number>) => string
}

export class Tokenizer extends Context.Service<Tokenizer, TokenizerService>()(
  "@betalyra/effect-uai/Tokenizer",
) {}
