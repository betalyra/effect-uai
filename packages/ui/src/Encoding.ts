/**
 * Wire framing for envelopes. SSE frames carry `id: <seq>` (so a browser's
 * auto-reconnect sends `Last-Event-ID`), `event: <type>` and the whole
 * envelope as JSON in `data`. For NDJSON use core's `JSONL.toBytes` /
 * `JSONL.parse` with `RunEvent.EnvelopeJson` directly.
 */
import type * as SSE from "@effect-uai/core/SSE"
import { Effect, Option, Schema, Stream } from "effect"
import { type Envelope, EnvelopeJson } from "./RunEvent.js"

const Wire = Schema.fromJsonString(EnvelopeJson)
const encode = Schema.encodeEffect(Wire)
const decode = Schema.decodeUnknownEffect(Wire)

/** Envelopes → SSE events, ready for core's `SSE.toBytes`. */
export const toSSE = <E, R>(
  self: Stream.Stream<Envelope, E, R>,
): Stream.Stream<SSE.Event, E | Schema.SchemaError, R> =>
  self.pipe(
    Stream.mapEffect((envelope) =>
      encode(envelope).pipe(
        Effect.map((data): SSE.Event => ({
          id: String(envelope.seq),
          event: envelope.event.type,
          data,
        })),
      ),
    ),
  )

/** SSE events (from core's `SSE.fromBytes`) → envelopes. */
export const fromSSE = <E, R>(
  self: Stream.Stream<SSE.Event, E, R>,
): Stream.Stream<Envelope, E | Schema.SchemaError, R> =>
  self.pipe(Stream.mapEffect((event) => decode(event.data)))

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
