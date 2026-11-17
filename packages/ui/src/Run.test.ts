import * as AiError from "@effect-uai/core/AiError"
import { describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { expect } from "vitest"
import * as Run from "./Run.js"
import { InputId, RunId, type RunEvent, StreamId } from "./RunEvent.js"

const r1 = RunId.make("r1")
const text = (t: string): RunEvent => ({ type: "text-delta", text: t })
const types = (events: ReadonlyArray<RunEvent>) => events.map((e) => e.type)

describe("Run frame", () => {
  const frame = <E>(body: Stream.Stream<RunEvent, E>) =>
    body.pipe(
      Stream.catchCause((cause) => Stream.succeed(Run.failed(cause))),
      Run.start({ runId: r1, inputs: [InputId.make("in_1")] }),
      Run.complete,
    )

  it.effect("brackets a successful body with run-started and run-completed", () =>
    frame(Stream.make(text("hi"))).pipe(
      Stream.runCollect,
      Effect.map((events) => {
        expect(types(events)).toEqual(["run-started", "text-delta", "run-completed"])
        expect(events[0]).toMatchObject({ runId: "r1", inputs: ["in_1"] })
      }),
    ),
  )

  it.effect("turns a failure into run-failed with the error's tag", () =>
    frame(
      Stream.make(text("partial")).pipe(
        Stream.concat(Stream.fail(new AiError.RateLimited({ provider: "x", raw: null }))),
      ),
    ).pipe(
      Stream.runCollect,
      Effect.map((events) => {
        expect(types(events)).toEqual(["run-started", "text-delta", "run-failed"])
        expect(events.at(-1)).toEqual({ type: "run-failed", reason: "RateLimited" })
      }),
    ),
  )

  it.effect("lets the body's own terminal win and end the run", () =>
    frame(
      Stream.fromIterable<RunEvent>([
        text("needs approval"),
        { type: "run-interrupted", interrupts: [] },
        text("never sent"),
      ]),
    ).pipe(
      Stream.runCollect,
      Effect.map((events) =>
        expect(types(events)).toEqual(["run-started", "text-delta", "run-interrupted"]),
      ),
    ),
  )

  it.effect("ends with run-stopped when the stop signal completes", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>()
      const fiber = yield* Stream.make(text("streaming")).pipe(
        Stream.concat(Stream.never),
        Run.stopWhen(Deferred.await(stop)),
        frame,
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
      { type: "run-started", runId: r1, inputs: [], protocol: 3 },
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

describe("Run.sequenceOwned", () => {
  it.effect("keeps each event with its own run when two runs interleave", () => {
    const run = (id: string) =>
      Stream.make(text(`${id}-a`), text(`${id}-b`)).pipe(
        Run.start({ runId: RunId.make(id), name: id }),
        Run.complete,
        Run.within(RunId.make(id)),
      )
    return run("planner").pipe(
      Stream.interleave(run("program")),
      Stream.concat(Run.streamScoped(Stream.make({ type: "live", name: "clock", value: 1 }))),
      Run.sequenceOwned(StreamId.make("st_1")),
      Stream.runCollect,
      Effect.map((frames) => {
        expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
        const owner = (label: string) =>
          frames.find((f) => f.event.type === "text-delta" && f.event.text === label)?.runId
        expect([owner("planner-b"), owner("program-a")]).toEqual(["planner", "program"])
        expect(frames.at(-1)?.runId).toBeUndefined()
      }),
    )
  })
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
