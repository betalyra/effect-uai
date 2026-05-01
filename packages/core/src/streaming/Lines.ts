import { Stream } from "effect"

/**
 * Accumulate streaming string chunks into complete newline-delimited
 * lines. Chunks may arrive split across line boundaries; the operator
 * buffers until it sees a `\n`. Empty lines are dropped, `\r` is
 * stripped (handles `\r\n` line endings).
 *
 * Intended use: feed text deltas from a model stream that has been
 * prompted to emit JSONL (or any other newline-delimited format), then
 * parse / validate each emitted line.
 */
export const accumulateLines = <E, R>(
  self: Stream.Stream<string, E, R>,
): Stream.Stream<string, E, R> =>
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

/**
 * Same as `accumulateLines` but flushes any non-empty buffered tail at
 * stream end. Use when the upstream stream may not terminate with a
 * trailing newline (typical of LLM token streams).
 */
export const accumulateLinesWithFlush = <E, R>(
  self: Stream.Stream<string, E, R>,
): Stream.Stream<string, E, R> => accumulateLines(Stream.concat(self, Stream.make("\n")))
