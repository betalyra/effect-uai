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
import { Effect, type Option, Stream } from "effect"
import type { HttpClient, HttpClientRequest } from "effect/http"
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
export const direct = <I, S>(options: {
  readonly request: (input: I, state: S) => HttpClientRequest.HttpClientRequest
  readonly format?: "sse" | "ndjson"
}): Transport<I, S, Client.ClientError, HttpClient.HttpClient> => ({
  start: (input, state): Stream.Stream<Envelope, Client.ClientError, HttpClient.HttpClient> =>
    options.format === "ndjson"
      ? Client.ndjson(options.request(input, state))
      : Client.sse(options.request(input, state)),
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
export const durable = <I, S, ES, RS, EE, RE, EX = never, RX = never>(options: {
  readonly submit: (input: I, state: S) => Effect.Effect<{ readonly streamId: StreamId }, ES, RS>
  readonly events: (streamId: StreamId, after: number) => Stream.Stream<Envelope, EE, RE>
  readonly stop?: (streamId: StreamId) => Effect.Effect<void, EX, RX>
}): Transport<I, S, ES | EE | EX, RS | RE | RX> => ({
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
