import { describe, it } from "@effect/vitest"
import { Data, Effect, Ref, Schedule, Stream } from "effect"
import { expect } from "vitest"
import * as Client from "./Client.js"
import { type Envelope, RunId, type RunEvent, StreamId } from "./RunEvent.js"

const r1 = RunId.make("r1")

class Dropped extends Data.TaggedError("Dropped")<{}> {}

const frames: ReadonlyArray<Envelope> = (
  [
    { type: "run-started", runId: r1, messageId: "m1", inputs: [], protocol: 1 },
    { type: "text-delta", text: "a" },
    { type: "text-delta", text: "b" },
    { type: "text-delta", text: "c" },
    { type: "run-completed" },
  ] satisfies ReadonlyArray<RunEvent>
).map((event, i) => ({ streamId: StreamId.make("s"), seq: i + 1, runId: r1, event }))

// A server that replays from `after`; how each connection ends is scripted.
const server = (endings: ReadonlyArray<{ readonly upTo: number; readonly fails: boolean }>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<number>>([])
    const connect = (after: number) =>
      Stream.unwrap(
        Ref.modify(calls, (cs) => [cs.length, [...cs, after]]).pipe(
          Effect.map((attempt) => {
            const ending = endings[attempt] ?? { upTo: frames.length, fails: false }
            // Re-sends one frame it already delivered, as real servers may.
            const sent = Stream.fromIterable(frames.slice(Math.max(0, after - 1), ending.upTo))
            return ending.fails ? sent.pipe(Stream.concat(Stream.fail(new Dropped()))) : sent
          }),
        ),
      )
    return { calls, connect }
  })

describe("Client.resumable", () => {
  it.effect.each([
    { label: "a failed connection", fails: true },
    { label: "a connection that closes before the terminal", fails: false },
  ])("resumes after $label from the last seq, without duplicates", ({ fails }) =>
    Effect.gen(function* () {
      const { calls, connect } = yield* server([{ upTo: 2, fails }])
      const received = yield* Client.resumable(connect, { schedule: Schedule.recurs(3) }).pipe(
        Stream.runCollect,
      )
      expect(received.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
      expect(yield* Ref.get(calls)).toEqual([0, 2])
    }),
  )
})
