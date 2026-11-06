/**
 * Browser-safe sources of envelopes. Every source yields
 * `Stream<Envelope>`; `resumable` adds reconnect-from-last-seq on top of
 * any of them. HTTP goes through `effect/http`'s `HttpClient`, so a browser
 * provides `FetchHttpClient.layer` and tests provide a fake client.
 */
import * as JSONL from "@effect-uai/core/JSONL"
import * as SSE from "@effect-uai/core/SSE"
import { Data, Effect, Ref, type Schedule, type Schema, Stream } from "effect"
import { HttpClient, type HttpClientError, type HttpClientRequest } from "effect/http"
import * as Encoding from "./Encoding.js"
import { type Envelope, EnvelopeJson, isTerminal } from "./RunEvent.js"

/** The connection ended before the run's terminal event arrived. */
export class Disconnected extends Data.TaggedError("Disconnected")<{ readonly lastSeq: number }> {}

/** What an HTTP source can fail with: transport, a malformed SSE frame, or a malformed NDJSON line. */
export type ClientError =
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | JSONL.JsonParseError

const responseBody = (request: HttpClientRequest.HttpClientRequest) =>
  Stream.unwrap(
    HttpClient.HttpClient.pipe(
      Effect.map(HttpClient.filterStatusOk),
      Effect.flatMap((client) => client.execute(request)),
      Effect.map((response) => response.stream),
    ),
  )

/** An SSE response (`text/event-stream`) as envelopes. */
export const sse = (request: HttpClientRequest.HttpClientRequest) =>
  responseBody(request).pipe(SSE.fromBytes, Encoding.fromSSE)

/** An NDJSON response (one envelope per line) as envelopes. */
export const ndjson = (request: HttpClientRequest.HttpClientRequest) =>
  responseBody(request).pipe(JSONL.fromBytes, JSONL.parse(EnvelopeJson))

/**
 * Keep events flowing across dropped connections: `connect(after)` is
 * re-invoked with the last seen `seq` on failure, per `schedule`; duplicates
 * are dropped. A connection that ends cleanly before the end counts as a
 * failure (`Disconnected`), so it is retried too.
 *
 * `until: "terminal"` (default) follows one run and completes after its
 * terminal. `until: "never"` follows a session stream that carries many runs
 * (a durable chat) and never completes on its own.
 */
export const resumable = <E, R, X>(
  connect: (after: number) => Stream.Stream<Envelope, E, R>,
  options: {
    readonly from?: number
    readonly until?: "terminal" | "never"
    readonly schedule: Schedule.Schedule<X, E | Disconnected>
  },
): Stream.Stream<Envelope, E | Disconnected, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const last = yield* Ref.make(options.from ?? 0)
      const done = yield* Ref.make(false)
      const untilTerminal = options.until !== "never"
      const attempt = Stream.unwrap(
        Ref.get(last).pipe(
          Effect.map((after) =>
            connect(after).pipe(
              Stream.filterEffect((envelope) =>
                Ref.modify(last, (seq) =>
                  envelope.seq > seq ? [true, envelope.seq] : [false, seq],
                ),
              ),
              Stream.takeUntil((envelope) => untilTerminal && isTerminal(envelope.event)),
              Stream.tap((envelope) =>
                untilTerminal && isTerminal(envelope.event) ? Ref.set(done, true) : Effect.void,
              ),
              Stream.concat(
                Stream.unwrap(
                  Effect.all([Ref.get(done), Ref.get(last)]).pipe(
                    Effect.map(([isDone, seq]) =>
                      isDone ? Stream.empty : Stream.fail(new Disconnected({ lastSeq: seq })),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
      return attempt.pipe(Stream.retry(options.schedule))
    }),
  )
