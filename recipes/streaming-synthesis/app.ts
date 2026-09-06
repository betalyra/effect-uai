/**
 * Composition for the streaming-synthesis recipe: static assets, a bundled
 * browser client, and a `/ws` route that upgrades to a duplex pipe:
 *
 *   browser text  ->  Stream<string>  ->  streamSynthesisFrom  ->  audio  ->  browser
 *
 * The queue stays open across submissions, so each Enter from the browser
 * adds another sentence to the same upstream TTS session rather than starting
 * a new one. `run.ts` supplies the platform `HttpServer`, `FileSystem` and
 * `Path`.
 */
import { Cause, Channel, Effect, FileSystem, Layer, Path, Queue, Stdio, Stream } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { providerChoice } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { incrementalSynthesizerLayer } from "../_shared/model.js"
import { type Provider, providerConfig, synthesizeText } from "./recipe.js"

const decoder = new TextDecoder()

/**
 * One submission goes upstream as a single frame, so the provider sees one
 * generation unit: smoother prosody, no per-word seams. The trailing
 * terminator nudges it to flush promptly rather than wait for more text.
 */
const TERMINATED = /[.!?]\s*$/

const submission = (raw: string): string | undefined => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  return TERMINATED.test(trimmed) ? `${trimmed} ` : `${trimmed}. `
}

const textOf = (buf: Uint8Array): string | undefined =>
  Effect.runSync(
    Effect.try({
      // A raw WebSocket frame, so plain JSON is the right tool.
      // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
      try: () => (JSON.parse(decoder.decode(buf)) as { readonly text?: unknown }).text,
      catch: () => "malformed" as const,
    }).pipe(
      Effect.map((t) => (typeof t === "string" ? t : undefined)),
      Effect.orElseSucceed(() => undefined),
    ),
  )

const wsHandler = (provider: Provider) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[ws] browser connected")

    const textIn = yield* Queue.unbounded<string, Cause.Done<void>>()
    const audioOut = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>()

    yield* Stream.fromQueue(textIn).pipe(
      synthesizeText(provider),
      Stream.runForEach((chunk) => Queue.offer(audioOut, chunk.bytes)),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("[pipeline] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(Queue.end(audioOut)),
      Effect.forkScoped,
    )

    yield* Stream.toChannel(Stream.fromQueue(audioOut)).pipe(
      Channel.pipeTo(HttpServerRequest.upgradeChannel<never>()),
      Stream.fromChannel,
      Stream.runForEach((buf) => {
        const text = textOf(buf)
        const frame = text === undefined ? undefined : submission(text)
        return frame === undefined ? Effect.void : Effect.asVoid(Queue.offer(textIn, frame))
      }),
      Effect.catchTag("SocketError", () => Effect.logInfo("[ws] browser disconnected")),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[ws] browser disconnected")
          : Effect.logError("[ws] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(Queue.end(textIn)),
      Effect.ignore,
    )

    return HttpServerResponse.empty()
  })

const js = (body: string) =>
  HttpServerResponse.text(body, { contentType: "application/javascript; charset=utf-8" })

type Assets = {
  readonly provider: Provider
  readonly indexHtml: string
  readonly clientJs: string
  readonly playbackWorkletJs: string
}

const routesLayer = (assets: Assets) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/", HttpServerResponse.html(assets.indexHtml)),
    HttpRouter.add("GET", "/client.js", js(assets.clientJs)),
    HttpRouter.add("GET", "/playback-worklet.js", js(assets.playbackWorkletJs)),
    HttpRouter.add("GET", "/ws", wsHandler(assets.provider)),
  )

export const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const provider = yield* providerChoice("elevenlabs", "inworld")
  const { model } = providerConfig(provider)

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "public/index.html"))
  const playbackWorkletJs = yield* fs.readFileString(
    path.join(recipeDir, "public/playback-worklet.js"),
  )

  yield* Effect.logInfo(`streaming-synthesis (${provider} ${model})`)

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`, so keep returning the
  // launch effect here.
  // @effect-diagnostics-next-line effect/returnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(routesLayer({ provider, indexHtml, clientJs, playbackWorkletJs })),
  ).pipe(Effect.provide(incrementalSynthesizerLayer({ provider, model })))
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
