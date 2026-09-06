/**
 * Composition for the streaming-transcription recipe: static assets, a
 * bundled browser client, and a `/ws` route that upgrades to a duplex pipe:
 *
 *   browser mic PCM  ->  Stream<Uint8Array>  ->  streamTranscriptionFrom  ->  browser
 *
 * `/config` hands the browser the provider's expected sample rate, since the
 * mic worklet has to resample to it. `run.ts` supplies the platform
 * `HttpServer`, `FileSystem` and `Path`.
 */
import { Cause, Channel, Effect, FileSystem, Layer, Path, Queue, Stream } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { providerChoice } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { streamingTranscriberLayer } from "../_shared/model.js"
import { type Provider, providerConfig, transcribeMicStream } from "./recipe.js"

const wsHandler = (provider: Provider) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[ws] browser connected")

    const micIn = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>()
    const eventsOut = yield* Queue.unbounded<string, Cause.Done<void>>()

    yield* Stream.fromQueue(micIn).pipe(
      transcribeMicStream(provider),
      // Plain JSON is the right tool for serializing a WebSocket frame.
      // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
      Stream.runForEach((event) => Queue.offer(eventsOut, JSON.stringify(event))),
      Effect.tapCause((cause) =>
        // Clean teardown (browser disconnect, upstream WS close) arrives as
        // an interrupt; only real failures are worth logging.
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("[pipeline] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(Queue.end(eventsOut)),
      Effect.forkScoped,
    )

    yield* Stream.toChannel(Stream.fromQueue(eventsOut)).pipe(
      Channel.pipeTo(HttpServerRequest.upgradeChannel<never>()),
      Stream.fromChannel,
      Stream.runForEach((bytes) => Queue.offer(micIn, bytes)),
      Effect.catchTag("SocketError", () => Effect.logInfo("[ws] browser disconnected")),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[ws] browser disconnected")
          : Effect.logError("[ws] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(Queue.end(micIn)),
      Effect.ignore,
    )

    return HttpServerResponse.empty()
  })

const js = (body: string) =>
  HttpServerResponse.text(body, { contentType: "application/javascript; charset=utf-8" })

type Assets = {
  readonly provider: Provider
  readonly sampleRate: number
  readonly indexHtml: string
  readonly clientJs: string
  readonly audioWorkletJs: string
}

const routesLayer = (assets: Assets) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/", HttpServerResponse.html(assets.indexHtml)),
    HttpRouter.add("GET", "/client.js", js(assets.clientJs)),
    HttpRouter.add("GET", "/audio-worklet.js", js(assets.audioWorkletJs)),
    HttpRouter.add(
      "GET",
      "/config",
      HttpServerResponse.text(
        JSON.stringify({ provider: assets.provider, sampleRate: assets.sampleRate }),
        { contentType: "application/json; charset=utf-8" },
      ),
    ),
    HttpRouter.add("GET", "/ws", wsHandler(assets.provider)),
  )

export const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const provider = yield* providerChoice("openai", "elevenlabs", "inworld")
  const { inputFormat, model } = providerConfig(provider)

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "public/index.html"))
  const audioWorkletJs = yield* fs.readFileString(path.join(recipeDir, "public/audio-worklet.js"))

  yield* Effect.logInfo(
    `streaming-transcription (${provider} ${model}, ${inputFormat.sampleRate} Hz)`,
  )

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`, so keep returning the
  // launch effect here.
  // @effect-diagnostics-next-line effect/returnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(
      routesLayer({
        provider,
        sampleRate: inputFormat.sampleRate,
        indexHtml,
        clientJs,
        audioWorkletJs,
      }),
    ),
  ).pipe(Effect.provide(streamingTranscriberLayer({ provider, model })))
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
