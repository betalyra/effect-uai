/**
 * Browser-safe sources of envelopes. Every source yields
 * `Stream<Envelope>`; `resumable` adds reconnect-from-last-seq on top of
 * any of them. HTTP goes through `effect/http`'s `HttpClient`, so a browser
 * provides `FetchHttpClient.layer` and tests provide a fake client.
 */
import { Data, Effect, Ref, type Schedule, type Schema, Stream } from "effect"
import { Ndjson, type Sse } from "effect/encoding"
import { HttpClient, type HttpClientError, type HttpClientRequest } from "effect/http"
import { type Envelope, EnvelopeJson, isTerminal } from "./RunEvent.js"
import * as SseEncoding from "./SseEncoding.js"

/** The connection ended before the run's terminal event arrived. */
export class Disconnected extends Data.TaggedError("Disconnected")<{ readonly lastSeq: number }> {}

/** What an HTTP source can fail with: transport, a malformed SSE frame, or a malformed NDJSON line. */
export type ClientError =
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | Sse.Retry
  | Sse.SseError
  | Ndjson.NdjsonError

/** Run a request, failing on a non-2xx status. */
export const execute = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => HttpClient.filterStatusOk(client).execute(request)),
  )

const body = (request: HttpClientRequest.HttpClientRequest) =>
  Stream.unwrap(Effect.map(execute(request), (response) => response.stream))

/** An SSE response (`text/event-stream`) as envelopes. */
export const sse = (request: HttpClientRequest.HttpClientRequest) =>
  body(request).pipe(SseEncoding.decode)

/** An NDJSON response (one envelope per line) as envelopes. */
export const ndjson = (request: HttpClientRequest.HttpClientRequest) =>
  body(request).pipe(Stream.pipeThroughChannelOrFail(Ndjson.decodeSchema(EnvelopeJson)()))

/**
 * Keep events flowing across dropped connections: `connect(after)` is
 * re-invoked with the last seen `seq` on failure, per `schedule`; duplicates
 * are dropped. A connection that ends cleanly before the end counts as a
 * failure (`Disconnected`), so it is retried too. Without `schedule` nothing
 * is retried: an early end just fails with `Disconnected`.
 *
 * `until: "terminal"` (default) follows one run and completes after its
 * terminal. `until: "never"` follows a session stream that carries many runs
 * (a durable chat) and never completes on its own.
 */
export const resumable = <E, R, X = never>(
  connect: (after: number) => Stream.Stream<Envelope, E, R>,
  options?: {
    readonly from?: number
    readonly until?: "terminal" | "never"
    readonly schedule?: Schedule.Schedule<X, E | Disconnected>
  },
): Stream.Stream<Envelope, E | Disconnected, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const untilTerminal = options?.until !== "never"
      const ends = (envelope: Envelope) => untilTerminal && isTerminal(envelope.event)
      // The last seen seq, and whether the run's terminal arrived.
      const position = yield* Ref.make({ seq: options?.from ?? 0, done: false })
      const attempt = Stream.unwrap(
        Ref.get(position).pipe(
          Effect.map(({ seq: after }) =>
            connect(after).pipe(
              Stream.filterEffect((envelope) =>
                Ref.modify(position, (p) =>
                  envelope.seq > p.seq
                    ? [true, { seq: envelope.seq, done: ends(envelope) }]
                    : [false, p],
                ),
              ),
              Stream.takeUntil(ends),
              Stream.concat(
                Stream.unwrap(
                  Ref.get(position).pipe(
                    Effect.map((p) =>
                      p.done ? Stream.empty : Stream.fail(new Disconnected({ lastSeq: p.seq })),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
      const schedule = options?.schedule
      return schedule === undefined ? attempt : attempt.pipe(Stream.retry(schedule))
    }),
  )
