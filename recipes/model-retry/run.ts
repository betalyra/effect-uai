/**
 * Runner for the model-retry recipe. Wires up the real Responses
 * provider + logging and drives the conversation built in `index.ts`.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/model-retry/run.ts`
 */
import { Config, Effect, Layer, Logger, Match, References, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Turn from "@effect-uai/core/Turn"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { conversation } from "./index.js"

const program = Stream.runForEach(conversation, (event) =>
  Match.value(event).pipe(
    Match.discriminators("_tag")({
      TurnComplete: ({ turn }) =>
        Effect.logInfo("turn complete", {
          stop_reason: turn.stop_reason,
          assistant: Turn.assistantTexts(turn).join(" "),
        }),
    }),
    Match.orElse(() => Effect.void),
  ),
)

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
