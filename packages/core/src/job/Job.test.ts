import { describe, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect, expectTypeOf } from "vitest"
import * as AiError from "../domain/AiError.js"
import { type JobRef, JobState, collect, jobRef, refSchema, run, watch } from "./Job.js"

const ref = jobRef<string>("test", "job-1")

/** Answers each poll with the next scripted state, repeating the last. */
const scripted = (states: ReadonlyArray<JobState<string>>) =>
  Effect.map(Ref.make(0), (calls) => ({
    calls,
    poll: () =>
      Effect.map(
        Ref.getAndUpdate(calls, (n) => n + 1),
        (n) => states[Math.min(n, states.length - 1)]!,
      ),
  }))

describe("watch", () => {
  it.effect("emits every polled state and ends with the settled one", () =>
    Effect.gen(function* () {
      const { poll } = yield* scripted([
        JobState.Pending({ queuePosition: 2 }),
        JobState.Running(),
        JobState.Succeeded({ result: "video.mp4" }),
      ])

      const fiber = yield* Effect.forkChild(
        Stream.runCollect(watch(poll, ref, { pollInterval: "1 second" })),
      )
      yield* Effect.repeat(TestClock.adjust("1 second"), { times: 4 })

      expect(yield* Fiber.join(fiber)).toEqual([
        JobState.Pending({ queuePosition: 2 }),
        JobState.Running(),
        JobState.Succeeded({ result: "video.mp4" }),
      ])
    }),
  )
})

describe("collect", () => {
  it.effect("polls through the live states and stops at the first settled one", () =>
    Effect.gen(function* () {
      const { calls, poll } = yield* scripted([
        JobState.Pending({ queuePosition: 3 }),
        JobState.Pending({ queuePosition: 1 }),
        JobState.Running(),
        JobState.Succeeded({ result: "video.mp4" }),
        JobState.Succeeded({ result: "never reached" }),
      ])

      const fiber = yield* Effect.forkChild(collect(poll, ref, { pollInterval: "1 second" }))
      // Step the clock: each poll's sleep is scheduled only after the previous poll ran.
      yield* Effect.repeat(TestClock.adjust("1 second"), { times: 9 })

      expect(yield* Fiber.join(fiber)).toBe("video.mp4")
      // Four polls, not five: the loop stops rather than running the schedule out.
      expect(yield* Ref.get(calls)).toBe(4)
    }),
  )

  it.effect("fails with the error the provider classified, not a generic one", () =>
    Effect.gen(function* () {
      const refused = new AiError.ContentFiltered({ provider: "test", raw: { code: 1026 } })
      const { poll } = yield* scripted([JobState.Failed({ error: refused })])

      const error = yield* Effect.flip(collect(poll, ref, { pollInterval: "1 second" }))
      expect(error).toBe(refused)
    }),
  )

  it.effect("fails `Timeout` when the job never settles", () =>
    Effect.gen(function* () {
      const { poll } = yield* scripted([JobState.Running()])

      const fiber = yield* Effect.forkChild(
        Effect.flip(collect(poll, ref, { pollInterval: "1 second", timeout: "30 seconds" })),
      )
      yield* TestClock.adjust("31 seconds")

      expect((yield* Fiber.join(fiber))._tag).toBe("Timeout")
    }),
  )

  it.effect("bounds the whole loop rather than each individual poll", () =>
    Effect.gen(function* () {
      // Every poll finishes well inside the timeout; their sum does not. A
      // per-attempt deadline would never fire here.
      const { poll } = yield* scripted([JobState.Running()])
      const slow = () => Effect.delay(poll(), "5 seconds")

      const fiber = yield* Effect.forkChild(
        Effect.flip(collect(slow, ref, { pollInterval: "1 second", timeout: "20 seconds" })),
      )
      yield* TestClock.adjust("21 seconds")

      expect((yield* Fiber.join(fiber))._tag).toBe("Timeout")
    }),
  )
})

describe("run", () => {
  it.effect("cancels the server job when the caller is interrupted", () =>
    Effect.gen(function* () {
      const cancelled = yield* Ref.make(false)
      const { poll } = yield* scripted([JobState.Running()])

      const fiber = yield* Effect.forkChild(
        run(
          { submit: Effect.succeed(ref), poll, cancel: () => Ref.set(cancelled, true) },
          { pollInterval: "1 second" },
        ),
      )
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(fiber)

      expect(yield* Ref.get(cancelled)).toBe(true)
    }),
  )

  it.effect("cancels the server job when its own timeout gives up on it", () =>
    Effect.gen(function* () {
      const cancelled = yield* Ref.make(false)
      const { poll } = yield* scripted([JobState.Running()])

      const fiber = yield* Effect.forkChild(
        Effect.flip(
          run(
            { submit: Effect.succeed(ref), poll, cancel: () => Ref.set(cancelled, true) },
            { pollInterval: "1 second", timeout: "5 seconds" },
          ),
        ),
      )
      yield* TestClock.adjust("6 seconds")

      expect((yield* Fiber.join(fiber))._tag).toBe("Timeout")
      expect(yield* Ref.get(cancelled)).toBe(true)
    }),
  )
})

describe("JobRef", () => {
  // The constructor and the schema are written independently, so a field
  // added to one and not the other only shows up here.
  it.effect("decodes a ref built by its own constructor, typed by refSchema", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeEffect(refSchema<string>())(jobRef("fal", "req-9"))
      expectTypeOf(decoded).toEqualTypeOf<JobRef<string>>()
      expect(decoded).toEqual({ _tag: "JobRef", provider: "fal", id: "req-9" })
    }),
  )
})
