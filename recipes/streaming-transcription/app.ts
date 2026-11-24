/**
 * Composition for the streaming-transcription recipe: static assets, a
 * bundled browser client, and a `/ws` live session:
 *
 *   browser mic (channel 0)  ->  streamTranscriptionFrom  ->  utterance entries  ->  browser
 *
 * The session declares the mic format itself (`channel-opened`), so the page
 * needs no config route. `run.ts` supplies the platform `HttpServer`,
 * `FileSystem` and `Path`.
 */
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Frame from "@effect-uai/ui/Frame"
import * as LiveSocket from "@effect-uai/ui/LiveSocket"
import * as Run from "@effect-uai/ui/Run"
import { StreamId } from "@effect-uai/ui/RunEvent"
import { providerChoice } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { streamingTranscriberLayer } from "../_shared/model.js"
import { Up } from "./contract.js"
import { type Provider, providerConfig, transcriptSession } from "./recipe.js"

const session = (provider: Provider) =>
  LiveSocket.handle({
    up: Up,
    handler: (up) =>
      up.pipe(
        transcriptSession(provider),
        Run.streamScoped,
        Stream.map(Frame.message),
        Frame.sequence(StreamId.make("transcript")),
      ),
  })

const js = (body: string) =>
  HttpServerResponse.text(body, { contentType: "application/javascript; charset=utf-8" })

type Assets = {
  readonly provider: Provider
  readonly indexHtml: string
  readonly clientJs: string
  readonly worklets: ReadonlyArray<readonly [name: string, code: string]>
}

const routesLayer = (assets: Assets) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/", HttpServerResponse.html(assets.indexHtml)),
    HttpRouter.add("GET", "/client.js", js(assets.clientJs)),
    ...assets.worklets.map(([name, code]) =>
      HttpRouter.add("GET", `/worklets/${name}.mjs`, js(code)),
    ),
    HttpRouter.add("GET", "/ws", session(assets.provider)),
  )

// The audio worklet: `Media.micWorklet` resolves next to the bundled
// `/client.js`, so it is served from `/worklets/`.
const readWorklets = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* Effect.forEach(names, (name) =>
      path.fromFileUrl(new URL(import.meta.resolve(`@effect-uai/ui/worklets/${name}`))).pipe(
        Effect.flatMap(fs.readFileString),
        Effect.map((code) => [name, code] as const),
      ),
    )
  })

export const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const provider = yield* providerChoice("openai", "elevenlabs", "inworld")
  const { inputFormat, model } = providerConfig(provider)

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "public/index.html"))
  const worklets = yield* readWorklets(["mic"])

  yield* Effect.logInfo(
    `streaming-transcription (${provider} ${model}, ${inputFormat.sampleRate} Hz)`,
  )

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`, so keep returning the
  // launch effect here.
  // @effect-diagnostics-next-linereturnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(routesLayer({ provider, indexHtml, clientJs, worklets })),
  ).pipe(Effect.provide(streamingTranscriberLayer({ provider, model })))
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
