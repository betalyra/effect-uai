/**
 * Composition for the mid-stream-abort recipe. Forks a timer that completes
 * the abort `Deferred` after `--abort-after`, which is what a real app would
 * do from a UI button or a signal handler.
 */
import { Deferred, Effect, Match, Option, Stdio, Stream } from "effect"
import type { Duration } from "effect"
import * as Turn from "@effect-uai/core/Turn"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { DEFAULT_MODEL, conversation } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => DEFAULT_MODEL),
    "openai",
  )
  const abortAfter = Option.getOrElse(
    flagValue("abort-after", argv),
    () => "3 seconds",
  ) as Duration.Input

  const abort = yield* Deferred.make<void>()

  yield* Effect.forkChild(
    Effect.gen(function* () {
      yield* Effect.sleep(abortAfter)
      yield* Effect.logInfo(`abort fired after ${String(abortAfter)}`)
      yield* Deferred.succeed(abort, undefined)
    }),
  )

  yield* Stream.runForEach(
    conversation(spec.model).pipe(Stream.interruptWhen(Deferred.await(abort))),
    (event) =>
      Match.value(event).pipe(
        Match.discriminators("_tag")({
          TextDelta: ({ text }) => Effect.logInfo("delta", { text }),
          TurnComplete: ({ turn }) =>
            Effect.logInfo("turn complete (not expected if abort fires first)", {
              stop_reason: turn.stop_reason,
              assistant: Turn.assistantTexts(turn).join(" "),
            }),
        }),
        Match.orElse(() => Effect.void),
      ),
  ).pipe(Effect.provide(languageModelLayer(spec)))

  yield* Effect.logInfo("loop ended")
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
