import { Stream } from "effect"
import { Sse } from "effect/unstable/encoding"

/**
 * One Server-Sent Event. Fields per the WHATWG spec:
 * - `event`: optional event name (absent for the default "message")
 * - `data`: payload, with multiple `data:` lines joined by `\n`
 * - `id`: optional last-event id
 */
export type Event = {
  readonly event?: string
  readonly data: string
  readonly id?: string
}

const toEvent = (wire: Sse.Event): Event => ({
  data: wire.data,
  ...(wire.event !== "message" && { event: wire.event }),
  ...(wire.id !== undefined && { id: wire.id }),
})

type ParserState = {
  readonly parser: Sse.Parser
  readonly out: Array<Event>
}

const makeParserState = (): ParserState => {
  const out: Array<Event> = []
  const parser = Sse.makeParser((event) => {
    // `retry:` reconnection hints have no representation in `Event`
    if (event._tag === "Event") out.push(toEvent(event))
  })
  return { parser, out }
}

/**
 * Decode a `Stream<Uint8Array>` (e.g. an HTTP response body) into a
 * `Stream<SSE.Event>`, using the spec parser from `effect/unstable/encoding`.
 * An event is dispatched only once its terminating blank line arrives, so a
 * partial event at stream end (clean or failed) is discarded per the spec
 * rather than surfaced as a truncated frame.
 */
export const fromBytes = <E, R>(
  self: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<Event, E, R> =>
  self.pipe(
    Stream.decodeText,
    Stream.mapAccum(makeParserState, (state, text: string) => {
      state.parser.feed(text)
      return [state, state.out.splice(0)] as const
    }),
  )

const encoder = new TextEncoder()

/**
 * Encode a `Stream<Event>` as `Stream<Uint8Array>` ready to send on an
 * HTTP response with `Content-Type: text/event-stream`.
 */
export const toBytes = <E, R>(self: Stream.Stream<Event, E, R>): Stream.Stream<Uint8Array, E, R> =>
  Stream.map(self, (ev) =>
    encoder.encode(
      Sse.encoder.write({
        _tag: "Event",
        event: ev.event ?? "message",
        id: ev.id,
        data: ev.data,
      }),
    ),
  )
