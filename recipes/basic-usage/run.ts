/**
 * Runner for the basic-usage recipe. Wires up the real Responses provider
 * + logging and drives the conversation built in `index.ts`.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-usage/run.ts`
 */
import { Config, Effect, Layer, Logger, Match, References, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { matchType } from "@effect-uai/core/Match"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { conversation } from "./index.js"

const program = Effect.gen(function* () {
  yield* Stream.runForEach(conversation, (event) =>
    Match.value(event).pipe(
      matchType("turn_complete", ({ turn }) =>
        Effect.logInfo("turn complete", {
          stop_reason: turn.stop_reason,
          usage: turn.usage,
        }),
      ),
      Match.when({ _tag: "Output" }, ({ result }) =>
        Effect.logInfo("tool result", { result }),
      ),
      Match.when({ _tag: "Intermediate" }, () => Effect.void),
      Match.orElse(() => Effect.logDebug("delta", { event })),
    ),
  )
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
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
