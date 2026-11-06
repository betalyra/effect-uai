/**
 * SSE framing for envelopes, on Effect's `effect/encoding/Sse`. A frame
 * carries `id: <seq>` (so a browser's auto-reconnect sends `Last-Event-ID`),
 * `event: <type>` and the envelope's JSON in `data`. `EnvelopeEvent` is that
 * mapping as a Schema; `encode` / `decode` run it with Effect's SSE
 * encoder and parser.
 * For NDJSON use `effect/encoding/Ndjson` with `RunEvent.EnvelopeJson`.
 */
import { Effect, Option, Schema, SchemaTransformation, Stream } from "effect"
import { Sse } from "effect/encoding"
import { Envelope, EnvelopeJson } from "./RunEvent.js"

/** An envelope as an SSE event: `id` = seq, `event` = type, `data` = the envelope as JSON. */
export const EnvelopeEvent = Schema.Struct({
  id: Schema.optional(Schema.String),
  event: Schema.String,
  data: Schema.fromJsonString(EnvelopeJson),
}).pipe(
  Schema.decodeTo(
    Schema.toType(Envelope),
    SchemaTransformation.transform({
      decode: (event) => event.data,
      encode: (envelope) => ({
        id: String(envelope.seq),
        event: envelope.event.type,
        data: envelope,
      }),
    }),
  ),
)

const encodeEvent = Schema.encodeEffect(EnvelopeEvent)

/** Envelopes → an SSE response body. */
export const encode = <E, R>(
  self: Stream.Stream<Envelope, E, R>,
): Stream.Stream<Uint8Array, E | Schema.SchemaError, R> =>
  self.pipe(
    Stream.mapEffect((envelope) =>
      encodeEvent(envelope).pipe(
        Effect.map((event) => Sse.encoder.write({ _tag: "Event", id: event.id, ...event })),
      ),
    ),
    Stream.encodeText,
  )

/** An SSE response body → envelopes. A `retry:` hint from the server fails with `Sse.Retry`. */
export const decode = <E, R>(
  self: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<Envelope, E | Sse.Retry | Sse.SseError | Schema.SchemaError, R> =>
  self.pipe(Stream.decodeText, Stream.pipeThroughChannelOrFail(Sse.decodeSchema(EnvelopeEvent)))

/**
 * Headers an SSE response needs. Behind nginx-style proxies, also send
 * `x-accel-buffering: no` so frames are not buffered.
 */
export const responseHeaders: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
}

const parseSeq = Schema.decodeUnknownOption(Schema.FiniteFromString.check(Schema.isInt()))

/**
 * The `seq` a reconnecting SSE client last received, from the standard
 * `Last-Event-ID` header (a browser's EventSource sends it on every
 * auto-reconnect). Accepts web `Headers` or Effect's record headers.
 *
 * Prefer it over any position the app carries in the URL: EventSource keeps
 * reconnecting to its original URL, so a URL position goes stale.
 */
export const lastEventId = (
  headers: Headers | { readonly [key: string]: string | undefined },
): Option.Option<number> =>
  Option.fromNullishOr(
    headers instanceof Headers ? headers.get("last-event-id") : headers["last-event-id"],
  ).pipe(Option.flatMap(parseSeq))
