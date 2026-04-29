import { Stream } from "effect"

/**
 * One Server-Sent Event. Fields per the WHATWG spec:
 * - `event`: optional event name (default "message" on the wire)
 * - `data`: payload, with multiple `data:` lines joined by `\n`
 * - `id`: optional last-event id
 */
export interface Event {
  readonly event?: string
  readonly data: string
  readonly id?: string
}

// ---------------------------------------------------------------------------
// Generic stream helpers (kept module-local for now; promote to a shared
// Stream module once a third caller appears).
// ---------------------------------------------------------------------------

/** Decode `Uint8Array` chunks as UTF-8, handling multi-byte boundaries. */
const decodeText = <E, R>(self: Stream.Stream<Uint8Array, E, R>): Stream.Stream<string, E, R> =>
  self.pipe(
    Stream.mapAccum(
      (): TextDecoder => new TextDecoder("utf-8"),
      (decoder, chunk: Uint8Array) => [decoder, [decoder.decode(chunk, { stream: true })]] as const,
      {
        onHalt: (decoder: TextDecoder) => {
          const tail = decoder.decode()
          return tail.length > 0 ? [tail] : []
        },
      },
    ),
  )

/** Split a text stream on a separator, buffering across chunk boundaries. */
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
        { onHalt: (tail: string) => (tail.length > 0 ? [tail] : []) },
      ),
    )

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const parseField = (line: string): readonly [string, string] => {
  const colon = line.indexOf(":")
  if (colon < 0) return [line, ""]
  const value = line.slice(colon + 1)
  return [line.slice(0, colon), value.startsWith(" ") ? value.slice(1) : value]
}

const parseBlock = (block: string): Event | null => {
  const lines = block.split("\n").filter((l) => l.length > 0 && !l.startsWith(":"))
  if (lines.length === 0) return null

  const fields = lines.map(parseField)
  const dataLines = fields.filter(([f]) => f === "data").map(([, v]) => v)
  const event = fields.find(([f]) => f === "event")?.[1]
  const id = fields.find(([f]) => f === "id")?.[1]

  const out: { event?: string; data: string; id?: string } = {
    data: dataLines.join("\n"),
  }
  if (event !== undefined) out.event = event
  if (id !== undefined) out.id = id
  return out as Event
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a `Stream<Uint8Array>` (e.g. an HTTP response body) into a
 * `Stream<SSE.Event>`. Handles partial UTF-8 sequences, CRLF/LF line
 * endings, and events split across chunk boundaries.
 */
export const fromBytes = <E, R>(
  self: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<Event, E, R> =>
  self.pipe(
    decodeText,
    Stream.map((s) => s.replace(/\r/g, "")), // SSE allows CRLF; normalize to LF
    splitOn("\n\n"),
    Stream.map(parseBlock),
    Stream.filter((ev): ev is Event => ev !== null),
  )

const eventToString = (ev: Event): string => {
  const parts: string[] = []
  if (ev.event !== undefined) parts.push(`event: ${ev.event}`)
  if (ev.id !== undefined) parts.push(`id: ${ev.id}`)
  for (const line of ev.data.split("\n")) parts.push(`data: ${line}`)
  return parts.join("\n") + "\n\n"
}

const encoder = new TextEncoder()

/**
 * Encode a `Stream<Event>` as `Stream<Uint8Array>` ready to send on an
 * HTTP response with `Content-Type: text/event-stream`.
 */
export const toBytes = <E, R>(self: Stream.Stream<Event, E, R>): Stream.Stream<Uint8Array, E, R> =>
  Stream.map(self, (ev) => encoder.encode(eventToString(ev)))
