/**
 * Composition for the streaming-synthesis recipe: static assets, a bundled
 * browser client, and a `/ws` live session:
 *
 *   browser lines  ->  streamSynthesisFrom  ->  speech on channel 0  ->  browser
 *
 * One synthesis session stays open for the whole socket, so each line the
 * browser sends joins the same upstream TTS session rather than starting a
 * new one. `run.ts` supplies the platform `HttpServer`, `FileSystem` and
 * `Path`.
 */
import { Effect, FileSystem, Layer, Path } from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { fileURLToPath } from "node:url"
import * as Frame from "@effect-uai/ui/Frame"
import * as LiveSocket from "@effect-uai/ui/LiveSocket"
import { StreamId } from "@effect-uai/ui/RunEvent"
import { providerChoice } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { incrementalSynthesizerLayer } from "../_shared/model.js"
import { Say } from "./contract.js"
import { type Provider, providerConfig, speechSession } from "./recipe.js"

const session = (provider: Provider) =>
  LiveSocket.handle({
    up: Say,
    handler: (up) => up.pipe(speechSession(provider), Frame.sequence(StreamId.make("synthesis"))),
  })

const js = (body: string) =>
  HttpServerResponse.text(body, { contentType: "application/javascript; charset=utf-8" })

type Assets = {
  readonly provider: Provider
  readonly indexHtml: string
  readonly clientJs: string
}

const routesLayer = (assets: Assets) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/", HttpServerResponse.html(assets.indexHtml)),
    HttpRouter.add("GET", "/client.js", js(assets.clientJs)),
    // The `@effect-uai/ui` player worklet, at the path the client passes to `Media`.
    HttpRouter.add(
      "GET",
      "/worklets/player.mjs",
      HttpServerResponse.file(
        fileURLToPath(import.meta.resolve("@effect-uai/ui/worklets/player")),
        { contentType: "text/javascript" },
      ),
    ),
    HttpRouter.add("GET", "/ws", session(assets.provider)),
  )

export const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const provider = yield* providerChoice("elevenlabs", "inworld")
  const { model } = providerConfig(provider)

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "public/index.html"))

  yield* Effect.logInfo(`streaming-synthesis (${provider} ${model})`)

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`, so keep returning the
  // launch effect here.
  // @effect-diagnostics-next-linereturnEffectInGen:off
  return Layer.launch(HttpRouter.serve(routesLayer({ provider, indexHtml, clientJs }))).pipe(
    Effect.provide(incrementalSynthesizerLayer({ provider, model })),
  )
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
