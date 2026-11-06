/**
 * How a client reaches the server. Every transport turns an input into the
 * envelopes of the run it starts; durable transports can also re-attach to a
 * run and stop it. Missing capabilities are absent from the value, so a UI
 * can tell whether stop or resume exists.
 *
 * `I` is the app's input (`Input.Input` for the preset); `S` is the client
 * state passed to `start`, so a request can carry client-owned history or
 * any other app data.
 */
import { Effect, type Option, Schedule, Schema, Stream } from "effect"
import { HttpClient, type HttpClientRequest } from "effect/http"
import * as Client from "./Client.js"
import * as Run from "./Run.js"
import { type Envelope, type RunEvent, StreamId } from "./RunEvent.js"

export type Transport<I, S, E, R> = {
  /** Start a run for `input` and stream its envelopes. Interrupting the stream abandons it. */
  readonly start: (input: I, state: S) => Stream.Stream<Envelope, E, R>
  /** Re-attach to a run after a reload, from `after`. Durable only. */
  readonly resume?: (streamId: StreamId, after: number) => Stream.Stream<Envelope, E, R>
  /** Ask the server to stop a run. Durable only; direct mode stops by interrupting `start`. */
  readonly stop?: (streamId: StreamId) => Effect.Effect<void, E, R>
}

/**
 * Direct mode: one HTTP request per input whose response body is the run.
 * Stop interrupts the stream, which aborts the request; the server sees the
 * client go away and interrupts its run (`Stream.toReadableStream(body,
 * { signal: request.signal })`, or Effect's `HttpServer`).
 *
 * Any other source (RPC streams, server functions) is a transport too:
 * write `{ start: (input, state) => stream }` directly.
 */
export const direct = <I, S, EB = never, RB = never>(options: {
  readonly request: (
    input: I,
    state: S,
  ) => Effect.Effect<HttpClientRequest.HttpClientRequest, EB, RB>
  readonly format?: "sse" | "ndjson"
}): Transport<I, S, Client.ClientError | EB, HttpClient.HttpClient | RB> => ({
  start: (input, state) =>
    Stream.unwrap(
      options
        .request(input, state)
        .pipe(
          Effect.map(
            (request): Stream.Stream<Envelope, Client.ClientError, HttpClient.HttpClient> =>
              options.format === "ndjson" ? Client.ndjson(request) : Client.sse(request),
          ),
        ),
    ),
})

/**
 * Run the agent in the same process (browser agent, tests, Storybook). The
 * run's events are sequenced under `streamId`.
 */
export const local = <I, S, E, R>(
  run: (input: I, state: S) => Stream.Stream<RunEvent, E, R>,
  options?: { readonly streamId?: StreamId },
): Transport<I, S, E, R> => ({
  start: (input, state) =>
    run(input, state).pipe(Run.sequence(options?.streamId ?? StreamId.make("local"))),
})

/**
 * Durable runs: `submit` starts one on the server and returns its stream id;
 * `events` reads it from `after` (wrap it in `Client.resumable` to survive
 * drops). The run lives on the server, so a reload re-attaches with `resume`.
 */
/** A per-run transport that can re-attach to a run (durable). */
export type Resumable<I, S, E, R> = Transport<I, S, E, R> & {
  readonly resume: (streamId: StreamId, after: number) => Stream.Stream<Envelope, E, R>
}

export const durable = <I, S, ES, RS, EE, RE, EX = never, RX = never>(options: {
  readonly submit: (input: I, state: S) => Effect.Effect<{ readonly streamId: StreamId }, ES, RS>
  readonly events: (streamId: StreamId, after: number) => Stream.Stream<Envelope, EE, RE>
  readonly stop?: (streamId: StreamId) => Effect.Effect<void, EX, RX>
}): Resumable<I, S, ES | EE | EX, RS | RE | RX> => ({
  start: (input, state) =>
    Stream.unwrap(
      options.submit(input, state).pipe(Effect.map(({ streamId }) => options.events(streamId, 0))),
    ),
  resume: options.events,
  ...(options.stop !== undefined ? { stop: options.stop } : {}),
})

/**
 * A durable session (a chat): one stream carries every run, and the server
 * owns its history. `send` without a stream id starts a new session and
 * returns its id (the app's own chat id, branded); with one, it adds a run to
 * that session. `events` follows the whole session from `after` (wrap it in
 * `Client.resumable` with `until: "never"`). The run arrives on that stream,
 * not as a response to `send`.
 */
export type Session<I, S, E, R> = {
  readonly send: (
    streamId: Option.Option<StreamId>,
    input: I,
    state: S,
  ) => Effect.Effect<{ readonly streamId: StreamId }, E, R>
  readonly events: (streamId: StreamId, after: number) => Stream.Stream<Envelope, E, R>
  readonly stop?: (streamId: StreamId) => Effect.Effect<void, E, R>
}

export const session = <I, S, ES, RS, EE, RE, EX = never, RX = never>(options: {
  readonly send: (
    streamId: Option.Option<StreamId>,
    input: I,
    state: S,
  ) => Effect.Effect<{ readonly streamId: StreamId }, ES, RS>
  readonly events: (streamId: StreamId, after: number) => Stream.Stream<Envelope, EE, RE>
  readonly stop?: (streamId: StreamId) => Effect.Effect<void, EX, RX>
}): Session<I, S, ES | EE | EX, RS | RE | RX> => options

// ---------------------------------------------------------------------------
// Over HTTP: request builders in, transports out (no route convention)
// ---------------------------------------------------------------------------

/** What the HTTP helpers can fail with. */
export type HttpError = Client.ClientError | Client.Disconnected

const execute = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => HttpClient.filterStatusOk(client).execute(request)),
  )

// The stream id from the response JSON's `field` (`{ "streamId": "…" }` by default).
const streamIdFrom = (request: HttpClientRequest.HttpClientRequest, field: string) =>
  execute(request).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ [field]: StreamId }))),
    Effect.map((body) => ({ streamId: body[field]! })),
  )

type HttpOptions = {
  /** Field of the start / send response JSON holding the stream id. Default `"streamId"`. */
  readonly idField?: string
  /** Reconnect policy for a dropped event stream. */
  readonly reconnect?: Schedule.Schedule<unknown, HttpError>
}

/**
 * `durable` over HTTP: `submit` builds the request that starts a run (its
 * JSON response carries the stream id), `events` the SSE request for a run
 * from `after`, `stop` the stop request. Dropped event streams reconnect from
 * the last `seq` (default: exponential from 250 ms, 6 tries).
 */
export const durableHttp = <I, S, EB = never, RB = never>(
  options: HttpOptions & {
    readonly submit: (
      input: I,
      state: S,
    ) => Effect.Effect<HttpClientRequest.HttpClientRequest, EB, RB>
    readonly events: (streamId: StreamId, after: number) => HttpClientRequest.HttpClientRequest
    readonly stop?: (streamId: StreamId) => HttpClientRequest.HttpClientRequest
  },
): Resumable<I, S, HttpError | EB, HttpClient.HttpClient | RB> => {
  const stop = options.stop
  return durable({
    submit: (input: I, state: S) =>
      options
        .submit(input, state)
        .pipe(Effect.flatMap((r) => streamIdFrom(r, options.idField ?? "streamId"))),
    events: (streamId, after) =>
      Client.resumable((from) => Client.sse(options.events(streamId, from)), {
        from: after,
        schedule:
          options.reconnect ?? Schedule.exponential("250 millis").pipe(Schedule.upTo({ times: 6 })),
      }),
    ...(stop !== undefined
      ? { stop: (streamId: StreamId) => execute(stop(streamId)).pipe(Effect.asVoid) }
      : {}),
  })
}

/**
 * `session` over HTTP: `send` builds the request that adds an input (without
 * a stream id, the server starts a session; its JSON response carries the
 * id), `events` the SSE request for the whole session from `after`, `stop`
 * the stop request. The event stream reconnects forever (default: every
 * second); it carries many runs and never ends on its own.
 */
export const sessionHttp = <I, S, EB = never, RB = never>(
  options: HttpOptions & {
    readonly send: (
      streamId: Option.Option<StreamId>,
      input: I,
      state: S,
    ) => Effect.Effect<HttpClientRequest.HttpClientRequest, EB, RB>
    readonly events: (streamId: StreamId, after: number) => HttpClientRequest.HttpClientRequest
    readonly stop?: (streamId: StreamId) => HttpClientRequest.HttpClientRequest
  },
): Session<I, S, HttpError | EB, HttpClient.HttpClient | RB> => {
  const stop = options.stop
  return session({
    send: (streamId: Option.Option<StreamId>, input: I, state: S) =>
      options
        .send(streamId, input, state)
        .pipe(Effect.flatMap((r) => streamIdFrom(r, options.idField ?? "streamId"))),
    events: (streamId, after) =>
      Client.resumable((from) => Client.sse(options.events(streamId, from)), {
        from: after,
        until: "never",
        schedule: options.reconnect ?? Schedule.spaced("1 second"),
      }),
    ...(stop !== undefined
      ? { stop: (streamId: StreamId) => execute(stop(streamId)).pipe(Effect.asVoid) }
      : {}),
  })
}
