/**
 * Composition for the streaming-tool-output recipe. Shows the
 * progress-and-result pattern (`download_artifact`), which is the more visual
 * of the two; the sub-agent variant is `makeSubAgent` + `realInnerAgent` in
 * `recipe.ts`.
 */
import { Effect, Match, Option, Stdio, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { DEFAULT_MODEL, type State, buildConversation, makeDownloadTool } from "./recipe.js"

const downloadArtifact = makeDownloadTool()
const toolkit = Toolkit.make(downloadArtifact)

const initial: State = {
  history: [Items.userText("Download https://example.com/big-blob and tell me the byte count.")],
  index: 0,
}

const render = (model: string) =>
  Stream.runForEach(buildConversation(toolkit, initial, model), (event) =>
    Match.value(event).pipe(
      Match.when({ _tag: "Progress" }, (e) =>
        Effect.logInfo("download progress", { call_id: e.call_id, data: e.data }),
      ),
      Match.when({ _tag: "Output" }, ({ result }) => Effect.logInfo("download result", { result })),
      Match.discriminators("_tag")({
        TurnComplete: ({ turn }) =>
          Effect.logInfo("turn complete", {
            stop_reason: turn.stop_reason,
            usage: turn.usage,
          }),
      }),
      Match.orElse(() => Effect.void),
    ),
  )

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => DEFAULT_MODEL),
    "openai",
  )
  yield* render(spec.model).pipe(Effect.provide(languageModelLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
