/**
 * Composition for the sleeper-agent recipe: the simulated CI pipeline, the
 * renderer, and the `main` that drives the conversation from `recipe.ts`.
 *
 * There is no real CI system here, so `checkStatus` is a simulated pipeline
 * that advances pending -> running -> success across successive polls. The
 * model triggers a deploy, the loop blocks on the polling fiber, and once the
 * pipeline reaches a terminal state the model reports the outcome. Watch the
 * `[poll]` log lines tick by between the two model turns.
 *
 */
import { Effect, Match, Option, Ref, Stdio, Stream } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { conversation, type PipelineStatus } from "./recipe.js"

// ---------------------------------------------------------------------------
// Simulated CI pipeline. Each poll advances a per-pipeline tick counter; the
// first checks report progress and later checks settle on a terminal status.
// Stands in for a real `GET /pipelines/:id` against a CI provider.
// ---------------------------------------------------------------------------

const STATUS_BY_TICK: ReadonlyArray<PipelineStatus> = ["pending", "running", "running", "success"]

const makeSimulatedCheckStatus = Effect.gen(function* () {
  const ticks = yield* Ref.make(0)
  return (id: string): Effect.Effect<PipelineStatus> =>
    Ref.getAndUpdate(ticks, (n) => n + 1).pipe(
      Effect.map((n) => STATUS_BY_TICK[Math.min(n, STATUS_BY_TICK.length - 1)]!),
      Effect.tap((status) => Effect.logInfo("poll", { pipelineId: id, status })),
    )
})

// ---------------------------------------------------------------------------
// Render the conversation stream: text deltas stream inline, tool calls and
// turn boundaries render as labeled asides.
// ---------------------------------------------------------------------------

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => "gpt-5.4-mini"),
    "openai",
  )
  const checkStatus = yield* makeSimulatedCheckStatus

  yield* Stream.runForEach(conversation(checkStatus, spec.model, "2 seconds"), (event) =>
    Match.value(event).pipe(
      Match.tags({
        TextDelta: ({ text }) => write(text),
        ToolCallStart: ({ name }) => write(`\n[tool: ${name}]\n`),
        TurnComplete: ({ turn }) => write(`\n[turn complete: ${turn.stop_reason}]\n`),
      }),
      Match.orElse(() => Effect.void),
    ),
  ).pipe(Effect.provide(languageModelLayer(spec)))

  yield* write("\n")
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
