import { Stream } from "effect"

/**
 * Split a string stream on `\n`, emitting one line per element. Buffers
 * partial chunks until a newline arrives, and flushes any non-newline
 * tail at stream end - so streams that don't terminate with `\n`
 * (typical of LLM token streams) still get their last line. Empty lines
 * are dropped, `\r` is stripped (handles `\r\n` endings).
 *
 * Intended use: feed text deltas from a model that has been prompted to
 * emit JSONL (or any other newline-delimited format), then parse /
 * validate each emitted line.
 */
export const lines = <E, R>(self: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
  linesStrict(Stream.concat(self, Stream.make("\n")))

/**
 * Like `lines`, but only emits lines that were terminated by `\n`. Any
 * partial trailing content is dropped at stream end. Use when you want
 * strict "complete-line-or-nothing" semantics.
 */
export const linesStrict = <E, R>(self: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
  self.pipe(
    Stream.mapAccum(
      (): string => "",
      (buffer, chunk: string) => {
        const combined = buffer + chunk
        const parts = combined.split("\n")
        const tail = parts.pop() ?? ""
        return [tail, parts.map((line) => line.replace(/\r/g, ""))] as const
      },
    ),
    Stream.filter((line) => line.trim().length > 0),
  )
