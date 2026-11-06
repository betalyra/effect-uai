import * as AiError from "@effect-uai/core/AiError"
import { describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { expect } from "vitest"
import * as Run from "./Run.js"
import { InputId, RunId, type RunEvent, StreamId } from "./RunEvent.js"

const r1 = RunId.make("r1")
const text = (t: string): RunEvent => ({ type: "text-delta", text: t })
const types = (events: ReadonlyArray<RunEvent>) => events.map((e) => e.type)

describe("Run.withTerminal", () => {
  const run = Run.withTerminal({ runId: r1, inputs: [InputId.make("in_1")] })

  it.effect("brackets a successful body with run-started and run-completed", () =>
    Stream.make(text("hi")).pipe(
      run,
      Stream.runCollect,
      Effect.map((events) => {
        expect(types(events)).toEqual(["run-started", "text-delta", "run-completed"])
        expect(events[0]).toMatchObject({ runId: "r1", messageId: "r1", inputs: ["in_1"] })
      }),
    ),
  )

  it.effect("absorbs a failure as run-failed, retryable for transient provider errors", () =>
    Stream.make(text("partial")).pipe(
      Stream.concat(Stream.fail(new AiError.RateLimited({ provider: "x", raw: null }))),
      run,
      Stream.runCollect,
      Effect.map((events) => {
        expect(types(events)).toEqual(["run-started", "text-delta", "run-failed"])
        expect(events.at(-1)).toEqual({
          type: "run-failed",
          reason: "RateLimited",
          retryable: true,
        })
      }),
    ),
  )

  it.effect("lets the body's own terminal win and end the run", () =>
    Stream.fromIterable<RunEvent>([
      text("needs approval"),
      { type: "run-interrupted", interrupts: [] },
      text("never sent"),
    ]).pipe(
      run,
      Stream.runCollect,
      Effect.map((events) =>
        expect(types(events)).toEqual(["run-started", "text-delta", "run-interrupted"]),
      ),
    ),
  )

  it.effect("ends with run-stopped when stopWhen completes", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>()
      const fiber = yield* Stream.make(text("streaming")).pipe(
        Stream.concat(Stream.never),
        Run.withTerminal({ runId: r1, stopWhen: Deferred.await(stop) }),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* Deferred.succeed(stop, undefined)
      const events = yield* Fiber.join(fiber)
      expect(types(events)).toEqual(["run-started", "text-delta", "run-stopped"])
    }),
  )
})

describe("Run.sequence", () => {
  it.effect("numbers frames per stream and tags run-scoped ones with the open run", () =>
    Stream.fromIterable<RunEvent>([
      { type: "data", name: "before", value: 1 },
      { type: "run-started", runId: r1, messageId: "m1", inputs: [], protocol: 1 },
      text("hi"),
      { type: "run-completed" },
      { type: "live", name: "after", value: 2 },
    ]).pipe(
      Run.sequence(StreamId.make("st_1"), { from: 10 }),
      Stream.runCollect,
      Effect.map((frames) => {
        expect(frames.map((f) => f.seq)).toEqual([11, 12, 13, 14, 15])
        expect(frames.map((f) => f.runId)).toEqual([undefined, "r1", "r1", "r1", undefined])
      }),
    ),
  )
})

describe("Run.coalesce", () => {
  it.effect("merges adjacent deltas of the same kind and keeps everything else in order", () =>
    Stream.fromIterable<RunEvent>([
      text("Hel"),
      text("lo"),
      { type: "tool-call-args-delta", callId: "c1", delta: `{"a"` },
      { type: "tool-call-args-delta", callId: "c1", delta: ":1}" },
      { type: "tool-call-args-delta", callId: "c2", delta: "{}" },
      { type: "step-finished" },
      text("!"),
    ]).pipe(
      Run.coalesce("50 millis"),
      Stream.runCollect,
      Effect.map((events) =>
        expect(events).toEqual<ReadonlyArray<RunEvent>>([
          text("Hello"),
          { type: "tool-call-args-delta", callId: "c1", delta: `{"a":1}` },
          { type: "tool-call-args-delta", callId: "c2", delta: "{}" },
          { type: "step-finished" },
          text("!"),
        ]),
      ),
    ),
  )
})
