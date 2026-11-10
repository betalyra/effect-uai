/**
 * How a client reaches the server. Every transport turns an input into the
 * envelopes of the run it starts; durable transports can also re-attach to a
 * run and stop it. Missing capabilities are absent from the value, so a UI
 * can tell whether stop or resume exists.
 *
 * `I` is the app's input (`Input.Input` for the preset); `S` is the client
 * state passed to `start`, so a request can carry any app data from it (a
 * chat id, settings).
 */
import {
  DateTime,
  Duration,
  Effect,
  Option,
  Function,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientError, type HttpClientRequest } from "effect/http"
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
 * client go away and interrupts its run.
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

/** A per-run transport that can re-attach to a run (durable). `start` is `submit`, then `resume` from 0. */
export type Durable<I, S, E, R> = Transport<I, S, E, R> & {
  /** Start a run on the server and return its stream id. */
  readonly submit: (input: I, state: S) => Effect.Effect<StreamId, E, R>
  readonly resume: (streamId: StreamId, after: number) => Stream.Stream<Envelope, E, R>
}

const durableOf = <I, S, E, R>(parts: Omit<Durable<I, S, E, R>, "start">): Durable<I, S, E, R> => ({
  ...parts,
  start: (input, state) =>
    Stream.unwrap(Effect.map(parts.submit(input, state), (streamId) => parts.resume(streamId, 0))),
})

/**
 * Durable runs: `submit` starts one on the server and returns its stream id;
 * `events` reads it from `after`. The run lives on the server, so a reload
 * re-attaches with `resume`. A stream that ends before the run's terminal
 * fails with `Client.Disconnected`; pipe through `reconnect` to resume it.
 */
export const durable = <I, S, ES, RS, EE, RE, EX = never, RX = never>(options: {
  readonly submit: (input: I, state: S) => Effect.Effect<StreamId, ES, RS>
  readonly events: (streamId: StreamId, after: number) => Stream.Stream<Envelope, EE, RE>
  readonly stop?: (streamId: StreamId) => Effect.Effect<void, EX, RX>
}): Durable<I, S, ES | EE | EX | Client.Disconnected, RS | RE | RX> =>
  durableOf<I, S, ES | EE | EX | Client.Disconnected, RS | RE | RX>({
    submit: options.submit,
    resume: (streamId, after) =>
      Client.resumable((from) => options.events(streamId, from), { from: after }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  })

/**
 * A durable session (a chat): one stream carries every run, and the server
 * owns its history. `send` without a stream id starts a new session and
 * returns its id (the app's own chat id, branded); with one, it adds a run to
 * that session. `events` follows the whole session from `after`. The run
 * arrives on that stream, not as a response to `send`.
 */
export type Session<I, S, E, R> = {
  readonly send: (
    streamId: Option.Option<StreamId>,
    input: I,
    state: S,
  ) => Effect.Effect<StreamId, E, R>
  readonly events: (streamId: StreamId, after: number) => Stream.Stream<Envelope, E, R>
  readonly stop?: (streamId: StreamId) => Effect.Effect<void, E, R>
}

/**
 * A session stream never ends on its own, so one that completes fails with
 * `Client.Disconnected`; pipe through `reconnect` to resume it.
 */
export const session = <I, S, ES, RS, EE, RE, EX = never, RX = never>(options: {
  readonly send: (
    streamId: Option.Option<StreamId>,
    input: I,
    state: S,
  ) => Effect.Effect<StreamId, ES, RS>
  readonly events: (streamId: StreamId, after: number) => Stream.Stream<Envelope, EE, RE>
  readonly stop?: (streamId: StreamId) => Effect.Effect<void, EX, RX>
}): Session<I, S, ES | EE | EX | Client.Disconnected, RS | RE | RX> => ({
  ...options,
  events: (streamId, after) =>
    Client.resumable((from) => options.events(streamId, from), { from: after, until: "never" }),
})

// ---------------------------------------------------------------------------
// Over HTTP: `durable` and `session` with SSE events
// ---------------------------------------------------------------------------

/** What the HTTP helpers can fail with. */
export type HttpError = Client.ClientError | Client.Disconnected

type HttpOptions = {
  /** The SSE request for a stream from `after`. */
  readonly events: (streamId: StreamId, after: number) => HttpClientRequest.HttpClientRequest
  /** The request that stops a stream's active run. */
  readonly stop?: (streamId: StreamId) => HttpClientRequest.HttpClientRequest
}

const stopOver = (stop: HttpOptions["stop"]) =>
  stop === undefined
    ? {}
    : { stop: (streamId: StreamId) => Client.execute(stop(streamId)).pipe(Effect.asVoid) }

/**
 * `durable` over HTTP. `submit` starts a run and returns its stream id (the
 * app decodes its own response, e.g. with `HttpClientResponse.schemaJson`);
 * `events` is read as SSE. Pipe through `reconnect` to survive drops.
 */
export const durableHttp = <I, S, ES = never, RS = never>(
  options: HttpOptions & {
    readonly submit: (input: I, state: S) => Effect.Effect<StreamId, ES, RS>
  },
): Durable<I, S, HttpError | ES, HttpClient.HttpClient | RS> =>
  durable({
    submit: options.submit,
    events: (streamId, after) => Client.sse(options.events(streamId, after)),
    ...stopOver(options.stop),
  })

/**
 * `session` over HTTP. `send` adds an input and returns the session's stream
 * id (without one, the server starts a session); `events` follows the whole
 * session as SSE. Pipe through `reconnect` to survive drops.
 */
export const sessionHttp = <I, S, ES = never, RS = never>(
  options: HttpOptions & {
    readonly send: (
      streamId: Option.Option<StreamId>,
      input: I,
      state: S,
    ) => Effect.Effect<StreamId, ES, RS>
  },
): Session<I, S, HttpError | ES, HttpClient.HttpClient | RS> =>
  session({
    send: options.send,
    events: (streamId, after) => Client.sse(options.events(streamId, after)),
    ...stopOver(options.stop),
  })

// ---------------------------------------------------------------------------
// Reconnect: resume a dropped event stream from the last seq
// ---------------------------------------------------------------------------

export type ReconnectOptions<E> = {
  /**
   * When to retry. Default: exponential from 500 ms, capped at 10 s, jittered.
   * Cap your own exponential: the schedule resets only when a frame arrives,
   * so an idle session's backoff otherwise grows without bound.
   */
  readonly schedule?: Schedule.Schedule<unknown, E | Client.Disconnected>
  /** More errors to treat as transient, on top of drops, timeouts, 408 / 429 / 5xx and SSE `retry:`. */
  readonly while?: Predicate.Predicate<E>
  /** Max attempts in a row; the count resets once a frame arrives. Default: unlimited. */
  readonly times?: number
}

const defaultSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("10 seconds"),
]).pipe(Schedule.jittered)

const isDisconnected = (error: unknown): error is Client.Disconnected =>
  error instanceof Client.Disconnected

const isTransient = (error: unknown) => Sse.Retry.is(error) || HttpClient.isTransientError(error)

const parseSeconds = Schema.decodeUnknownOption(Schema.FiniteFromString)

// `Retry-After` is either seconds or an HTTP date.
const retryAfter = (value: string, now: number): Option.Option<Duration.Duration> =>
  parseSeconds(value).pipe(
    Option.map((seconds) => Duration.seconds(Math.max(0, seconds))),
    Option.orElse(() =>
      DateTime.make(value).pipe(
        Option.map((at) => Duration.millis(Math.max(0, DateTime.toEpochMillis(at) - now))),
      ),
    ),
  )

// The wait the server asked for: an SSE `retry:` line or a `Retry-After` header.
const serverDelay = (error: unknown, now: number): Option.Option<Duration.Duration> => {
  if (Sse.Retry.is(error)) return Option.some(error.duration)
  if (!HttpClientError.isHttpClientError(error)) return Option.none()
  return Option.fromNullishOr(error.response?.headers["retry-after"]).pipe(
    Option.flatMap((value) => retryAfter(value, now)),
  )
}

const policy = <E>(
  options: ReconnectOptions<E> | undefined,
): Schedule.Schedule<unknown, E | Client.Disconnected> => {
  const base = options?.schedule ?? defaultSchedule
  const extra = options?.while
  return (options?.times === undefined ? base : Schedule.upTo(base, { times: options.times })).pipe(
    Schedule.while(
      ({ input }) =>
        isDisconnected(input) || isTransient(input) || (extra !== undefined && extra(input)),
    ),
    Schedule.modifyDelay(({ input, duration, now }) =>
      Effect.succeed(
        Option.match(serverDelay(input, now), {
          onNone: () => duration,
          onSome: (asked) => Duration.max(duration, asked),
        }),
      ),
    ),
  )
}

/** A transport `reconnect` applies to: one with a position to resume from. */
export type Resumable = Session<any, any, any, any> | Durable<any, any, any, any>

/** What a transport can fail with. */
export type ErrorOf<T extends Resumable> =
  T extends Session<any, any, infer E, any>
    ? E
    : T extends Durable<any, any, infer E, any>
      ? E
      : never

type WithDisconnected<F> = F extends (...args: infer A) => Stream.Stream<infer X, infer E, infer R>
  ? (...args: A) => Stream.Stream<X, E | Client.Disconnected, R>
  : F

/** `T` with `Client.Disconnected` added to its streams; `send` / `submit` keep their exact types. */
export type Reconnected<T extends Resumable> = { readonly [K in keyof T]: WithDisconnected<T[K]> }

const isSession = (self: Resumable): self is Session<any, any, any, any> => "send" in self

const isResumable = (u: unknown): u is Resumable =>
  Predicate.hasProperty(u, "send") || Predicate.hasProperty(u, "resume")

/**
 * Resume a dropped event stream from the last seq, as `HttpClient.retryTransient`
 * does for requests. Retries drops (`Client.Disconnected`), timeouts, transport
 * errors, 408 / 429 / 5xx and an SSE `retry:` line, waiting at least what the
 * server asks for (`Retry-After`, `retry:`); anything else (404, 401, a
 * malformed frame) ends the stream with that error. `while` adds the app's own
 * transient errors (e.g. a dropped WebSocket).
 *
 * A session is followed forever; a durable run until its terminal. A durable
 * `submit` is never retried, so an input is never sent twice. Not for `direct`
 * / `local`: there the run is the request, with no position to resume from.
 *
 *   const transport = Transport.reconnect(Transport.sessionHttp({ send, events, stop }))
 *   const ws = pipe(Transport.session({ send, events }), Transport.reconnect({ while: isDropped }))
 */
export const reconnect: {
  <E>(options?: ReconnectOptions<E>): <T extends Resumable>(self: T) => Reconnected<T>
  <T extends Resumable>(self: T, options?: ReconnectOptions<ErrorOf<T>>): Reconnected<T>
} = Function.dual(
  (args) => isResumable(args[0]),
  (self: Resumable, options?: ReconnectOptions<unknown>): Resumable => {
    const schedule = policy(options)
    const resumed =
      (events: Session<any, any, any, any>["events"], until: "terminal" | "never") =>
      (streamId: StreamId, after: number) =>
        Client.resumable((from) => events(streamId, from), { from: after, until, schedule })
    return isSession(self)
      ? { ...self, events: resumed(self.events, "never") }
      : durableOf({ ...self, resume: resumed(self.resume, "terminal") })
  },
)
