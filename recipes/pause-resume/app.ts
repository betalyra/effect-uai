/**
 * Composition for the pause-resume recipe. The controller here stands in for
 * a UI button or a signal handler: it waits until the loop has finished
 * `--pause-after` turns, closes the latch, and reopens it `--pause-for`
 * later. Nothing is checkpointed, because state threads through the loop.
 */
import { Effect, Fiber, Latch, Match, Option, Ref, Stdio, Stream } from "effect"
import type { Duration } from "effect"
import * as Turn from "@effect-uai/core/Turn"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { DEFAULT_MODEL, conversation } from "./recipe.js"

const pauseController = (
  pauseLatch: Latch.Latch,
  turnsCompleted: Ref.Ref<number>,
  after: number,
  duration: Duration.Input,
) =>
  Effect.gen(function* () {
    yield* Effect.repeat(
      Effect.map(Ref.get(turnsCompleted), (n) => n >= after),
      { until: (reached) => reached, schedule: undefined },
    ).pipe(Effect.andThen(Effect.void))

    yield* Effect.logInfo(`pause - holding for ${String(duration)}`)
    yield* Latch.close(pauseLatch)

    yield* Effect.sleep(duration)

    yield* Effect.logInfo("resume")
    yield* Latch.open(pauseLatch)
  })

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => DEFAULT_MODEL),
    "openai",
  )
  const after = intFlag("pause-after", argv, 3)
  const duration = Option.getOrElse(
    flagValue("pause-for", argv),
    () => "30 seconds",
  ) as Duration.Input

  const pauseLatch = yield* Latch.make(true) // start open
  const turnsCompleted = yield* Ref.make(0)

  const controller = yield* Effect.forkChild(
    pauseController(pauseLatch, turnsCompleted, after, duration),
  )

  yield* Stream.runForEach(conversation(pauseLatch, turnsCompleted, spec.model), (event) =>
    Match.value(event).pipe(
      Match.tags({
        TurnComplete: ({ turn }) =>
          Effect.logInfo("turn complete", { assistant: Turn.assistantTexts(turn).join(" ") }),
      }),
      Match.orElse(() => Effect.void),
    ),
  ).pipe(Effect.provide(languageModelLayer(spec)))

  yield* Fiber.join(controller)
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
