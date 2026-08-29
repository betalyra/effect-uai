/**
 * Splitting documents into retrievable passages. The chunkers are pure and
 * synchronous; `layer` lifts one into the core `Chunker` tag so a hosted
 * chunking service can take its place without touching callers.
 *
 * Every chunk carries the offsets it came from, so
 * `input.slice(chunk.start, chunk.end) === chunk.text` always holds. Overlap
 * makes chunks share regions, never lose them.
 *
 * `recursive` is the one to reach for by default. `fixed` ignores structure,
 * `sentences` never cuts mid-sentence, `markdown` follows headers.
 */
import { Array as Arr, Effect, Layer, Option, pipe, Result } from "effect"
import { type Chunk, Chunker } from "@effect-uai/core/Chunker"
import { Tokenizer } from "@effect-uai/core/Tokenizer"

export type { Chunk } from "@effect-uai/core/Chunker"

/** How chunk size is counted. Chunkers call this on candidate chunks. */
export type Measure = (text: string) => number

export type Options = {
  /** In units of `measure`, approximately tokens with the default. Default 512. */
  readonly targetSize?: number
  /** Units of `measure` repeated from the end of the previous chunk. Default 0. */
  readonly overlap?: number
  /** Default: characters / 4, a rough token estimate for prose. */
  readonly measure?: Measure
}

export type Splitter = (text: string, options?: Options) => ReadonlyArray<Chunk>

const approximate: Measure = (text) => Math.ceil(text.length / 4)

type Span = { readonly start: number; readonly end: number }

type Settings = {
  readonly target: number
  readonly overlap: number
  readonly measure: Measure
}

const settings = (options: Options | undefined): Settings => ({
  target: options?.targetSize ?? 512,
  overlap: options?.overlap ?? 0,
  measure: options?.measure ?? approximate,
})

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

const sizeOf = (text: string, span: Span, s: Settings): number =>
  s.measure(text.slice(span.start, span.end))

/** Narrow a span to its non-whitespace core; a blank span drops out. */
const trim =
  (text: string) =>
  (span: Span): Result.Result<Span, void> => {
    const region = text.slice(span.start, span.end)
    const start = span.start + (region.length - region.trimStart().length)
    const end = span.end - (region.length - region.trimEnd().length)
    return start < end ? Result.succeed({ start, end }) : Result.failVoid
  }

/** Split a span on every separator match, keeping the trimmed parts between. */
const splitSpans = (text: string, span: Span, separator: RegExp): ReadonlyArray<Span> => {
  const cuts = Arr.map([...text.slice(span.start, span.end).matchAll(separator)], (m) => ({
    start: span.start + m.index,
    end: span.start + m.index + m[0].length,
  }))
  return pipe(
    Arr.zip(
      [span.start, ...Arr.map(cuts, (c) => c.end)],
      [...Arr.map(cuts, (c) => c.start), span.end],
    ),
    Arr.filterMap(([start, end]) => trim(text)({ start, end })),
  )
}

// Coarse to fine. Closing quotes may trail the sentence punctuation.
const PARAGRAPH = /\n[ \t]*(?:\n[ \t]*)+/gu
const LINE = /\n/gu
const SENTENCE = /(?<=[.!?…][)"'”’]*)\s+/gu
const WORD = /\s+/gu
const SEPARATORS: ReadonlyArray<RegExp> = [PARAGRAPH, LINE, SENTENCE, WORD]

/** Sentences are split by the time we get here, so oversized ones go to words. */
const WORD_LEVEL = 3

/**
 * `measure` is a black box, so size a character window by calibrating it once
 * over the region instead of probing per chunk.
 */
const charBudget = (text: string, span: Span, s: Settings): number => {
  const length = span.end - span.start
  const units = sizeOf(text, span, s)
  return Math.max(1, Math.round(units === 0 ? s.target : (s.target * length) / units))
}

const windows = (span: Span, budget: number, stride: number): ReadonlyArray<Span> =>
  Arr.unfold(span.start, (start) =>
    start >= span.end
      ? Option.none()
      : Option.some([
          { start, end: Math.min(start + budget, span.end) },
          // Once a window reaches the end, stop: with overlap the strides that
          // follow would only produce windows contained in this one.
          start + budget >= span.end ? span.end : start + stride,
        ] as const),
  )

/** Break a span down until every part fits: coarsest separator first, then blind. */
const explode = (text: string, span: Span, level: number, s: Settings): ReadonlyArray<Span> => {
  if (sizeOf(text, span, s) <= s.target) return [span]
  const separator = SEPARATORS[level]
  if (separator === undefined) {
    const budget = charBudget(text, span, s)
    return windows(span, budget, budget)
  }
  const parts = splitSpans(text, span, separator)
  // A separator that does not divide the region is no progress; try the next.
  return parts.length <= 1
    ? explode(text, span, level + 1, s)
    : Arr.flatMap(parts, (part) => explode(text, part, level + 1, s))
}

/**
 * The longest suffix of a chunk worth at most `overlap`. Never the whole
 * chunk, or packing would not advance. Relies on `measure` growing with the
 * text it is given, which every sane measure does.
 */
const carry = (text: string, spans: ReadonlyArray<Span>, s: Settings): ReadonlyArray<Span> => {
  const tail = Arr.drop(spans, 1)
  return s.overlap <= 0
    ? []
    : pipe(
        Arr.last(tail),
        Option.map((end) =>
          Arr.dropWhile(
            tail,
            (span) => sizeOf(text, { start: span.start, end: end.end }, s) > s.overlap,
          ),
        ),
        Option.getOrElse((): ReadonlyArray<Span> => []),
      )
}

/** One chunk covering a group of spans verbatim. An empty group yields none. */
const toChunk = (text: string, spans: ReadonlyArray<Span>): ReadonlyArray<Chunk> =>
  pipe(
    Option.all([Arr.head(spans), Arr.last(spans)]),
    Option.map(([first, last]): Chunk => ({
      text: text.slice(first.start, last.end),
      start: first.start,
      end: last.end,
    })),
    Option.match({ onNone: (): ReadonlyArray<Chunk> => [], onSome: (chunk) => [chunk] }),
  )

type Packing = {
  readonly chunks: ReadonlyArray<Chunk>
  readonly current: ReadonlyArray<Span>
}

/** Greedily fill chunks with consecutive spans, carrying overlap forward. */
const pack = (text: string, spans: ReadonlyArray<Span>, s: Settings): ReadonlyArray<Chunk> => {
  const packed = Arr.reduce(spans, { chunks: [], current: [] } as Packing, (acc, span) => {
    const first = acc.current[0]
    return first !== undefined && sizeOf(text, { start: first.start, end: span.end }, s) > s.target
      ? {
          chunks: [...acc.chunks, ...toChunk(text, acc.current)],
          current: [...carry(text, acc.current, s), span],
        }
      : { chunks: acc.chunks, current: [...acc.current, span] }
  })
  return [...packed.chunks, ...toChunk(text, packed.current)]
}

/** The input's content as a span, or nothing if it is blank. */
const content = (text: string): ReadonlyArray<Span> =>
  Arr.filterMap([{ start: 0, end: text.length }], trim(text))

// ---------------------------------------------------------------------------
// Chunkers
// ---------------------------------------------------------------------------

/**
 * Blind character windows, sized by calibrating `measure` over the input. Cuts
 * mid-word and mid-sentence, so reach for it when the input has no structure
 * worth respecting or a hard size ceiling matters more than readable passages.
 */
export const fixed: Splitter = (text, options) => {
  const s = settings(options)
  return Arr.flatMap(content(text), (span) => {
    const budget = charBudget(text, span, s)
    const stride = budget - Math.min(budget - 1, Math.round((s.overlap * budget) / s.target))
    return Arr.map(windows(span, budget, stride), (w) => ({
      text: text.slice(w.start, w.end),
      start: w.start,
      end: w.end,
    }))
  })
}

/**
 * Split on the coarsest separator that makes the pieces fit (blank line,
 * newline, sentence end, word), then refill up to `targetSize`. The default:
 * it keeps related prose together without knowing anything about the format.
 */
export const recursive: Splitter = (text, options) => {
  const s = settings(options)
  return Arr.flatMap(content(text), (span) => pack(text, explode(text, span, 0, s), s))
}

/** Pack whole sentences. Only a sentence longer than `targetSize` is cut. */
export const sentences: Splitter = (text, options) => {
  const s = settings(options)
  return Arr.flatMap(content(text), (span) =>
    pack(
      text,
      Arr.flatMap(splitSpans(text, span, PARAGRAPH), (paragraph) =>
        Arr.flatMap(splitSpans(text, paragraph, SENTENCE), (sentence) =>
          explode(text, sentence, WORD_LEVEL, s),
        ),
      ),
      s,
    ),
  )
}

const HEADER = /^#{1,6}[ \t]+\S.*$/gmu
const FENCE = /^[ \t]{0,3}(?:```|~~~).*$/gmu

/** Fenced code regions, where a `#` line is content rather than a heading. */
const fenced = (region: string): ReadonlyArray<Span> =>
  pipe(
    Arr.map([...region.matchAll(FENCE)], (m) => m.index),
    Arr.chunksOf(2),
    // An unclosed fence swallows the rest of the document, as a renderer does.
    Arr.map(([open, close]) => ({ start: open, end: close ?? region.length })),
  )

/** Spans running from each header to the next, plus any preamble. */
const sections = (text: string, span: Span): ReadonlyArray<Span> => {
  const region = text.slice(span.start, span.end)
  const code = fenced(region)
  const starts = Arr.dedupe([
    span.start,
    ...pipe(
      [...region.matchAll(HEADER)],
      Arr.filter((m) => !Arr.some(code, (f) => m.index > f.start && m.index < f.end)),
      Arr.map((m) => span.start + m.index),
    ),
  ])
  return Arr.filterMap(starts, (start, i) => trim(text)({ start, end: starts[i + 1] ?? span.end }))
}

/**
 * One chunk per `#`..`######` section, so a heading stays with the prose under
 * it. A section over `targetSize` is split with `recursive` inside its own
 * bounds; a chunk never spans two sections. Headings inside fenced code are
 * ignored; setext (`===` underline) headings are not recognized.
 */
export const markdown: Splitter = (text, options) => {
  const s = settings(options)
  return Arr.flatMap(content(text), (span) =>
    Arr.flatMap(sections(text, span), (section) => pack(text, explode(text, section, 0, s), s)),
  )
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Serve a chunker through the core `Chunker` tag. */
export const layer = (chunker: Splitter, options?: Options): Layer.Layer<Chunker> =>
  Layer.succeed(Chunker, { chunk: (text: string) => Effect.succeed(chunker(text, options)) })

/**
 * Run a chunker with a real tokenizer as its measure, so `targetSize` and
 * `overlap` count tokens rather than estimate them.
 */
export const withTokenizer =
  (chunker: Splitter) =>
  (
    text: string,
    options?: Omit<Options, "measure">,
  ): Effect.Effect<ReadonlyArray<Chunk>, never, Tokenizer> =>
    Effect.map(Tokenizer, (tokenizer) =>
      chunker(text, { ...options, measure: (part) => tokenizer.encode(part).length }),
    )
