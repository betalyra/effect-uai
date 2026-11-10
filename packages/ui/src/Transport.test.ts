import { describe, it } from "@effect/vitest"
import { Data, Duration, Effect, Fiber, Function, Ref, Schedule, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { expect, expectTypeOf } from "vitest"
import * as Client from "./Client.js"
import { type Envelope, RunId, type RunEvent, StreamId } from "./RunEvent.js"
import * as Transport from "./Transport.js"

const r1 = RunId.make("r1")
const chatId = StreamId.make("chat")

class SocketDropped extends Data.TaggedError("SocketDropped")<{}> {}

type Failure = HttpClientError.HttpClientError | Sse.Retry | SocketDropped

const frames: ReadonlyArray<Envelope> = (
  [
    { type: "run-started", runId: r1, inputs: [], protocol: 2 },
    { type: "text-delta", text: "a" },
    { type: "text-delta", text: "b" },
    { type: "text-delta", text: "c" },
    { type: "run-completed" },
  ] satisfies ReadonlyArray<RunEvent>
).map((event, i) => ({ streamId: chatId, seq: i + 1, runId: r1, event }))

const status = (code: number, headers: Record<string, string> = {}) => {
  const request = HttpClientRequest.get("/chats/chat/events")
  const response = HttpClientResponse.fromWeb(
    request,
    new Response(null, { status: code, headers }),
  )
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request, response }),
  })
}

type Attempt = { readonly upTo: number; readonly error?: Failure }

// A server that replays from `after`; how each connection ends is scripted.
// Past the script, it sends the rest and then stays open (a live session).
const server = (attempts: ReadonlyArray<Attempt>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<number>>([])
    const submits = yield* Ref.make(0)
    const events = (_: StreamId, after: number): Stream.Stream<Envelope, Failure> =>
      Stream.unwrap(
        Ref.modify(calls, (cs) => [cs.length, [...cs, after]]).pipe(
          Effect.map((n) => {
            const attempt = attempts[n]
            if (attempt === undefined) {
              return Stream.fromIterable(frames.slice(after)).pipe(Stream.concat(Stream.never))
            }
            const sent = Stream.fromIterable(frames.slice(after, attempt.upTo))
            const error = attempt.error
            return error === undefined ? sent : sent.pipe(Stream.concat(Stream.fail(error)))
          }),
        ),
      )
    const send = () => Effect.succeed(chatId)
    const submit = () => Ref.update(submits, (n) => n + 1).pipe(Effect.as(chatId))
    const session = Transport.session({ send, events })
    const durable = Transport.durable({ submit, events })
    return { calls, submits, session, durable }
  })

const fast = Schedule.forever

const seqs = (envelopes: ReadonlyArray<Envelope>) => envelopes.map((e) => e.seq)

const follow = (session: Transport.Session<unknown, unknown, unknown, never>, take = 5) =>
  session.events(chatId, 0).pipe(Stream.take(take), Stream.runCollect)

const failure = (session: Transport.Session<unknown, unknown, unknown, never>) =>
  session.events(chatId, 0).pipe(Stream.runDrain, Effect.flip)

describe("Transport.session / durable", () => {
  it.effect("a session stream that completes fails with Disconnected at the last seq", () =>
    Effect.gen(function* () {
      const { session } = yield* server([{ upTo: 2 }])
      expect(yield* failure(session)).toEqual(new Client.Disconnected({ lastSeq: 2 }))
    }),
  )

  it.effect("a durable run that completes before its terminal fails with Disconnected", () =>
    Effect.gen(function* () {
      const { durable } = yield* server([{ upTo: 3 }])
      const error = yield* durable.start(undefined, undefined).pipe(Stream.runDrain, Effect.flip)
      expect(error).toEqual(new Client.Disconnected({ lastSeq: 3 }))
    }),
  )
})

describe("Transport.reconnect", () => {
  it.effect.each([
    { label: "a clean close", error: undefined },
    { label: "a 503", error: status(503) },
    {
      label: "an SSE retry: line",
      error: new Sse.Retry({ duration: Duration.zero, lastEventId: "2" }),
    },
  ])("re-opens a session from the last seq after $label", ({ error }) =>
    Effect.gen(function* () {
      const { calls, session } = yield* server([
        error === undefined ? { upTo: 2 } : { upTo: 2, error },
      ])
      const received = yield* follow(Transport.reconnect(session, { schedule: fast }))
      expect(seqs(received)).toEqual([1, 2, 3, 4, 5])
      expect(yield* Ref.get(calls)).toEqual([0, 2])
    }),
  )

  it.effect.each([{ code: 404 }, { code: 401 }])(
    "ends with a $code, without retrying",
    ({ code }) =>
      Effect.gen(function* () {
        const { calls, session } = yield* server([{ upTo: 1, error: status(code) }])
        const error = yield* failure(Transport.reconnect(session, { schedule: fast }))
        expect(error).toEqual(status(code))
        expect(yield* Ref.get(calls)).toEqual([0])
      }),
  )

  it.effect("`while` adds the app's own transient errors, typed by the transport", () =>
    Effect.gen(function* () {
      const dropped = { upTo: 2, error: new SocketDropped() }
      const plain = yield* server([dropped])
      expect(yield* failure(Transport.reconnect(plain.session, { schedule: fast }))).toEqual(
        new SocketDropped(),
      )

      const extended = yield* server([dropped])
      const reconnected = Transport.reconnect(extended.session, {
        schedule: fast,
        while: (error) => {
          expectTypeOf(error).toEqualTypeOf<Failure | Client.Disconnected>()
          return error instanceof SocketDropped
        },
      })
      expect(seqs(yield* follow(reconnected))).toEqual([1, 2, 3, 4, 5])
    }),
  )

  it.effect("pipes, and keeps the transport's kind and errors", () =>
    Effect.gen(function* () {
      const { session, durable } = yield* server([{ upTo: 2, error: status(503) }])
      const piped = Function.pipe(session, Transport.reconnect({ schedule: fast }))
      expectTypeOf(piped).toExtend<
        Transport.Session<unknown, unknown, Failure | Client.Disconnected, never>
      >()
      expectTypeOf(Function.pipe(durable, Transport.reconnect())).toExtend<
        Transport.Durable<unknown, unknown, Failure | Client.Disconnected, never>
      >()
      expect(seqs(yield* follow(piped))).toEqual([1, 2, 3, 4, 5])
    }),
  )

  it.effect("`times` caps the attempts in a row", () =>
    Effect.gen(function* () {
      const { calls, session } = yield* server(
        Array.from({ length: 5 }, () => ({ upTo: 0, error: status(503) })),
      )
      const error = yield* failure(Transport.reconnect(session, { schedule: fast, times: 2 }))
      expect(error).toEqual(status(503))
      expect((yield* Ref.get(calls)).length).toBe(3)
    }),
  )

  it.effect("waits at least the server's Retry-After", () =>
    Effect.gen(function* () {
      const { calls, session } = yield* server([
        { upTo: 2, error: status(429, { "retry-after": "5" }) },
      ])
      const fiber = yield* follow(Transport.reconnect(session, { schedule: fast })).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust("4 seconds")
      expect(yield* Ref.get(calls)).toEqual([0])
      yield* TestClock.adjust("1 second")
      expect(seqs(yield* Fiber.join(fiber))).toEqual([1, 2, 3, 4, 5])
      expect(yield* Ref.get(calls)).toEqual([0, 2])
    }),
  )

  it.effect.each([
    { label: "after the first frames", upTo: 2, resumedFrom: 2 },
    { label: "before the first frame", upTo: 0, resumedFrom: 0 },
  ])("durable start submits once and resumes a drop $label", ({ upTo, resumedFrom }) =>
    Effect.gen(function* () {
      const { calls, submits, durable } = yield* server([{ upTo, error: status(502) }])
      const reconnected = Transport.reconnect(durable, { schedule: fast })
      const received = yield* reconnected.start(undefined, undefined).pipe(Stream.runCollect)
      expect(seqs(received)).toEqual([1, 2, 3, 4, 5])
      expect(yield* Ref.get(submits)).toBe(1)
      expect(yield* Ref.get(calls)).toEqual([0, resumedFrom])
    }),
  )
})
