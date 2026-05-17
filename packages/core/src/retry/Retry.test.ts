import { Cause, Effect, Exit, Option, Ref, Schedule, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AiError from "../domain/AiError.js"
import * as Retry from "./Retry.js"

// Each call pulls the next plan entry; the last entry repeats forever
// (so "succeed on attempt N" plans naturally re-yield success after).
const planned = <A, E>(
  attempts: Ref.Ref<number>,
  plan: ReadonlyArray<Stream.Stream<A, E>>,
): Stream.Stream<A, E> =>
  Stream.unwrap(
    Ref.getAndUpdate(attempts, (n) => n + 1).pipe(
      Effect.map((n) => plan[Math.min(n, plan.length - 1)]!),
    ),
  )

const plannedEffect = <A, E>(
  attempts: Ref.Ref<number>,
  plan: ReadonlyArray<Effect.Effect<A, E>>,
): Effect.Effect<A, E> =>
  Ref.getAndUpdate(attempts, (n) => n + 1).pipe(
    Effect.flatMap((n) => plan[Math.min(n, plan.length - 1)]!),
  )

describe("Retry.stream", () => {
  it("retries on RateLimited and yields success on the next attempt", async () => {
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const s = planned(attempts, [
        Stream.fail<AiError.AiError>(new AiError.RateLimited({ provider: "mock", raw: null })),
        Stream.fromIterable(["a", "b"]),
      ]).pipe(Retry.stream(Schedule.recurs(3)))
      const out = yield* Stream.runCollect(s)
      const count = yield* Ref.get(attempts)
      return { out: Array.from(out), count }
    })

    const { out, count } = await Effect.runPromise(program)
    expect(count).toBe(2)
    expect(out).toEqual(["a", "b"])
  })

  it("surfaces the underlying retryable failure when retries are exhausted", async () => {
    const cause = new AiError.Unavailable({ provider: "mock", raw: null })
    const s = Stream.fail<AiError.AiError>(cause).pipe(Retry.stream(Schedule.recurs(2)))

    const exit = await Effect.runPromise(Effect.exit(Stream.runCollect(s)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(cause))
    }
  })

  it("bypasses retry for non-retryable AiError (ContentFiltered)", async () => {
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const cause = new AiError.ContentFiltered({ provider: "mock", raw: null })
      const s = planned(attempts, [Stream.fail<AiError.AiError>(cause)]).pipe(
        Retry.stream(Schedule.recurs(5)),
      )
      const exit = yield* Effect.exit(Stream.runCollect(s))
      const count = yield* Ref.get(attempts)
      return { exit, count, cause }
    })

    const { exit, count, cause } = await Effect.runPromise(program)
    expect(count).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(cause))
    }
  })

  it("preserves items emitted before a retryable failure (and replays on retry)", async () => {
    // Documents the 'replays on retry' caveat: the entire stream re-runs.
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const s = planned(attempts, [
        Stream.concat(
          Stream.succeed("partial"),
          Stream.fail<AiError.AiError>(new AiError.Timeout({ provider: "mock", raw: null })),
        ),
        Stream.fromIterable(["partial", "done"]),
      ]).pipe(Retry.stream(Schedule.recurs(1)))
      const out = yield* Stream.runCollect(s)
      return Array.from(out)
    })

    const out = await Effect.runPromise(program)
    expect(out).toEqual(["partial", "partial", "done"])
  })
})

describe("Retry.effect", () => {
  it("retries on RateLimited and yields success on the next attempt", async () => {
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const value = yield* plannedEffect(attempts, [
        Effect.fail<AiError.AiError>(new AiError.RateLimited({ provider: "mock", raw: null })),
        Effect.succeed("ok"),
      ]).pipe(Retry.effect(Schedule.recurs(3)))
      const count = yield* Ref.get(attempts)
      return { value, count }
    })

    const { value, count } = await Effect.runPromise(program)
    expect(count).toBe(2)
    expect(value).toBe("ok")
  })

  it("surfaces the underlying retryable failure when retries are exhausted", async () => {
    const cause = new AiError.Unavailable({ provider: "mock", raw: null })
    const eff = Effect.fail<AiError.AiError>(cause).pipe(Retry.effect(Schedule.recurs(2)))

    const exit = await Effect.runPromise(Effect.exit(eff))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(cause))
    }
  })

  it("bypasses retry for non-retryable AiError (ContentFiltered)", async () => {
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const cause = new AiError.ContentFiltered({ provider: "mock", raw: null })
      const exit = yield* Effect.exit(
        plannedEffect(attempts, [Effect.fail<AiError.AiError>(cause)]).pipe(
          Retry.effect(Schedule.recurs(5)),
        ),
      )
      const count = yield* Ref.get(attempts)
      return { exit, count, cause }
    })

    const { exit, count, cause } = await Effect.runPromise(program)
    expect(count).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(cause))
    }
  })

  it("does NOT replay successful prior work — at-most-once semantics", async () => {
    // Contrast with Retry.stream: an Effect.retry only re-invokes the
    // failing computation. No replay of work done before the failure
    // (there's nothing to replay — Effects are single-shot).
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const value = yield* plannedEffect(attempts, [
        Effect.fail<AiError.AiError>(new AiError.Timeout({ provider: "mock", raw: null })),
        Effect.fail<AiError.AiError>(new AiError.Timeout({ provider: "mock", raw: null })),
        Effect.succeed("done"),
      ]).pipe(Retry.effect(Schedule.recurs(5)))
      const count = yield* Ref.get(attempts)
      return { value, count }
    })

    const { value, count } = await Effect.runPromise(program)
    expect(count).toBe(3)
    expect(value).toBe("done")
  })
})
