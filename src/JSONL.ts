import { Data, Effect, Schema, Stream } from "effect"

export class JsonParseError extends Data.TaggedError("JsonParseError")<{
  readonly line: string
  readonly cause: unknown
}> {}

// ---------------------------------------------------------------------------
// Generic stream helpers (kept module-local; see SSE.ts for the same shape).
// ---------------------------------------------------------------------------

const decodeText = <E, R>(
  self: Stream.Stream<Uint8Array, E, R>
): Stream.Stream<string, E, R> =>
  self.pipe(
    Stream.mapAccum(
      (): TextDecoder => new TextDecoder("utf-8"),
      (decoder, chunk: Uint8Array) =>
        [decoder, [decoder.decode(chunk, { stream: true })]] as const,
      {
        onHalt: (decoder: TextDecoder) => {
          const tail = decoder.decode()
          return tail.length > 0 ? [tail] : []
        }
      }
    )
  )

const splitOn =
  (separator: string) =>
  <E, R>(self: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
    self.pipe(
      Stream.mapAccum(
        (): string => "",
        (buffer, chunk: string) => {
          const parts = (buffer + chunk).split(separator)
          const tail = parts[parts.length - 1] ?? ""
          return [tail, parts.slice(0, -1)] as const
        },
        { onHalt: (tail: string) => (tail.length > 0 ? [tail] : []) }
      )
    )

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a `Stream<Uint8Array>` into a `Stream<string>` of newline-delimited
 * lines. Empty lines are skipped. Buffers across chunk boundaries.
 */
export const fromBytes = <E, R>(
  self: Stream.Stream<Uint8Array, E, R>
): Stream.Stream<string, E, R> =>
  self.pipe(
    decodeText,
    Stream.map((s) => s.replace(/\r/g, "")),
    splitOn("\n"),
    Stream.filter((line) => line.length > 0)
  )

/**
 * Validate each JSONL line against a Schema. JSON parse errors and Schema
 * decode errors both surface as a `JsonParseError` so callers can `catchTag`
 * uniformly.
 */
export const parse =
  <A, I>(schema: Schema.Codec<A, I>) =>
  <E, R>(
    self: Stream.Stream<string, E, R>
  ): Stream.Stream<A, JsonParseError | E, R> =>
    self.pipe(
      Stream.mapEffect((line) =>
        Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: (cause) => new JsonParseError({ line, cause })
        }).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(schema)(value).pipe(
              Effect.mapError((cause) => new JsonParseError({ line, cause }))
            )
          )
        )
      )
    )

const encoder = new TextEncoder()

/**
 * Serialize a stream of values to JSONL bytes. Encodes each value via
 * `Schema.encodeUnknownSync`. Each line ends with `\n`.
 */
export const toBytes =
  <A, I>(schema: Schema.Codec<A, I>) =>
  <E, R>(
    self: Stream.Stream<A, E, R>
  ): Stream.Stream<Uint8Array, E, R> =>
    self.pipe(
      Stream.map((value) => {
        const encoded = Schema.encodeUnknownSync(schema)(value)
        return encoder.encode(JSON.stringify(encoded) + "\n")
      })
    )
