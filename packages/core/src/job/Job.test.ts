import { describe, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { JobRef, JobState, collect, jobRef, run } from "./Job.js"

const ref = jobRef<string>("test", "job-1")

/** Answers each poll with the next scripted state, repeating the last. */
const scripted = (states: ReadonlyArray<JobState<string>>) =>
  Effect.map(Ref.make(0), (calls) => ({
    calls,
    poll: () =>
      Effect.flatMap(
        Ref.getAndUpdate(calls, (n) => n + 1),
        (n) => Effect.succeed(states[Math.min(n, states.length - 1)]!),
      ),
  }))

describe("collect", () => {
  it.effect("polls through the live states and stops at the first settled one", () =>
    Effect.gen(function* () {
      const { calls, poll } = yield* scripted([
        JobState.Pending(),
        JobState.Running({ queuePosition: 3 }),
        JobState.Running({ queuePosition: 1 }),
        JobState.Succeeded({ result: "video.mp4" }),
        JobState.Succeeded({ result: "never reached" }),
      ])

      const fiber = yield* Effect.forkChild(collect(poll, ref, { pollInterval: "1 second" }))
      yield* TestClock.adjust("10 seconds")

      expect(yield* Fiber.join(fiber)).toBe("video.mp4")
      // Four polls, not five: the loop stops rather than running the schedule out.
      expect(yield* Ref.get(calls)).toBe(4)
    }),
  )

  it.effect("carries the provider's reason and raw payload into the failure", () =>
    Effect.gen(function* () {
      const { poll } = yield* scripted([
        JobState.Failed({ reason: "content filtered", raw: { code: 1026 } }),
      ])

      const error = yield* Effect.flip(collect(poll, ref, { pollInterval: "1 second" }))
      expect(error._tag).toBe("GenerationFailed")
      expect(error).toMatchObject({ message: "content filtered", raw: { code: 1026 } })
    }),
  )

  it.effect("falls back to the ref when the provider reports no reason", () =>
    Effect.gen(function* () {
      const { poll } = yield* scripted([JobState.Failed({})])

      const error = yield* Effect.flip(collect(poll, ref, { pollInterval: "1 second" }))
      expect(error).toMatchObject({ message: "job failed", raw: ref })
    }),
  )

  it.effect("fails `Timeout` when the job never settles", () =>
    Effect.gen(function* () {
      const { poll } = yield* scripted([JobState.Running({})])

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
      const { poll } = yield* scripted([JobState.Running({})])
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
      const { poll } = yield* scripted([JobState.Running({})])

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
})

describe("JobRef", () => {
  // The constructor and the schema are written independently, so a field
  // added to one and not the other only shows up here.
  it.effect("decodes a ref built by its own constructor", () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeUnknownEffect(JobRef)(jobRef("fal", "req-9"))).toEqual({
        _tag: "JobRef",
        provider: "fal",
        id: "req-9",
      })
    }),
  )
})
