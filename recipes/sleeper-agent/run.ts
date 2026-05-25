/**
 * Runner for the external-task-polling recipe. Wires up the real Responses
 * provider + logging and drives the conversation built in `index.ts`.
 *
 * There is no real CI system here, so `checkStatus` is a simulated pipeline
 * that advances pending -> running -> success across successive polls. The
 * model triggers a deploy, the loop blocks on the polling fiber, and once the
 * pipeline reaches a terminal state the model reports the outcome. Watch the
 * `[poll]` log lines tick by between the two model turns.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/external-task-polling/run.ts`
 */
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { Config, Effect, Layer, Logger, Match, Ref, References, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { conversation, type PipelineStatus } from "./index.js"

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

const program = Effect.gen(function* () {
  const checkStatus = yield* makeSimulatedCheckStatus

  yield* Stream.runForEach(conversation(checkStatus, "2 seconds"), (event) =>
    Match.value(event).pipe(
      Match.tags({
        TextDelta: ({ text }) => write(text),
        ToolCallStart: ({ name }) => write(`\n[tool: ${name}]\n`),
        TurnComplete: ({ turn }) => write(`\n[turn complete: ${turn.stop_reason}]\n`),
      }),
      Match.orElse(() => Effect.void),
    ),
  )

  yield* write("\n")
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const mainLayer = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
