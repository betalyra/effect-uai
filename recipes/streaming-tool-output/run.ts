/**
 * Runner for the streaming-tool-output recipe. Demonstrates the
 * progress-and-result pattern (download_artifact) since it's the more
 * visual demo. Swap to the sub-agent variant by importing
 * `makeSubAgent` + `realInnerAgent` instead.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/streaming-tool-output/run.ts`
 */
import { Config, Effect, Layer, Logger, Match, References, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { type State, buildConversation, makeDownloadTool } from "./index.js"

const downloadArtifact = makeDownloadTool()
const allTools: ReadonlyArray<Tool.AnyKindTool> = [downloadArtifact]

const initial: State = {
  history: [
    Items.userText(
      "Download https://example.com/big-blob and tell me the byte count.",
    ),
  ],
  index: 0,
}

const program = Effect.gen(function* () {
  yield* Stream.runForEach(buildConversation(allTools, initial), (event) =>
    Match.value(event).pipe(
      Match.when({ _tag: "Intermediate" }, (e) =>
        Effect.logInfo("download progress", { call_id: e.call_id, data: e.data }),
      ),
      Match.when({ _tag: "Output" }, ({ result }) =>
        Effect.logInfo("download result", { result }),
      ),
      Match.discriminators("type")({
        turn_complete: ({ turn }) =>
          Effect.logInfo("turn complete", {
            stop_reason: turn.stop_reason,
            usage: turn.usage,
          }),
      }),
      Match.orElse(() => Effect.void),
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
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
