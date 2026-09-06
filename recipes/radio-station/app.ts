/**
 * Runtime-agnostic composition of the radio-station recipe.
 *
 * Everything that doesn't depend on Bun / Node / Deno lives here: the flags
 * (`--music-model`, `--planner-model`, `--brief`, `--tracks`, `--cache`),
 * the HTTP routes (`/`, `/client.js`, `/ws`) and their WebSocket handler,
 * and the bootstrap `main`, which bundles the browser client, reads the
 * static HTML and launches the router. `run.ts` supplies the platform
 * `HttpServer`, `FileSystem` and `Path`.
 *
 * Both music providers register the generic `MusicGenerator` tag, so
 * `--music-model google:lyria-3-clip-preview` changes only the Layer and
 * `recipe.ts` is untouched.
 */
import {
  Cause,
  Channel,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Stdio,
  Stream,
} from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { languageModelLayer, musicGeneratorLayer, parseModelSpec } from "../_shared/model.js"
import { cacheDir } from "@effect-uai/recipe-kit/output"
import { runStation, type ServerEvent } from "./recipe.js"

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    brief: Option.getOrElse(
      flagValue("brief", argv),
      () => "late-night lo-fi study session, mellow and instrumental",
    ),
    trackCount: intFlag("tracks", argv, 10),
    planner: parseModelSpec(
      Option.getOrElse(flagValue("planner-model", argv), () => "gpt-5.4-mini"),
      "openai",
    ),
    music: parseModelSpec(
      Option.getOrElse(flagValue("music-model", argv), () => "music_v1"),
      "elevenlabs",
    ),
    // Not `runDir`: a fresh directory per run would miss the cache every
    // time, and the whole point is that a replayed track is not re-generated.
    cache: cacheDir("radio-station", argv),
  }
})

// ---------------------------------------------------------------------------
// HTTP + WebSocket routes.
//
//   GET /          → static HTML shell (read from disk by `main`).
//   GET /client.js → bundled browser ESM (rolldown'd by `main`).
//   GET /ws        → upgrade to WebSocket, wire each connection into a
//                    fresh `runStation` instance with a per-connection
//                    ack queue for `track-ended` backpressure.
// ---------------------------------------------------------------------------

type RoutesConfig = {
  readonly brief: string
  readonly trackCount: number
  readonly tracksDir: string
  readonly plannerModel: string
  readonly musicModel: string
  readonly indexHtml: string
  readonly clientJs: string
}

const textDecoder = new TextDecoder()

const encodeFrame = (event: ServerEvent): string | Uint8Array =>
  event.type === "data" ? event.bytes : JSON.stringify(event)

const parseClientFrame = (
  buf: Uint8Array,
): Effect.Effect<Option.Option<{ readonly type?: string }>> =>
  Effect.try({
    // Plain JSON is the right tool for a raw WebSocket frame.
    // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
    try: () => JSON.parse(textDecoder.decode(buf)) as { readonly type?: string },
    catch: () => "malformed" as const,
  }).pipe(Effect.option)

const wsHandler = (cfg: RoutesConfig) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[ws] browser connected")

    const ack = yield* Queue.unbounded<void>()

    // Pipe the recipe's outgoing Stream into the WS upgrade Channel's
    // input side. The resulting Channel's output side carries the
    // browser->us bytes, which we drain to detect `track-ended` frames.
    const outgoing = runStation({
      brief: cfg.brief,
      trackCount: cfg.trackCount,
      tracksDir: cfg.tracksDir,
      plannerModel: cfg.plannerModel,
      musicModel: cfg.musicModel,
      waitTrackEnded: Queue.take(ack),
    }).pipe(Stream.orDie, Stream.map(encodeFrame))

    yield* Stream.toChannel(outgoing).pipe(
      Channel.pipeTo(HttpServerRequest.upgradeChannel<never>()),
      Stream.fromChannel,
      Stream.runForEach((buf) =>
        parseClientFrame(buf).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (event) =>
                event.type === "track-ended" ? Queue.offer(ack, undefined) : Effect.void,
            }),
          ),
        ),
      ),
      // Effect's `Socket` reports every WS close as a `SocketError`
      // (it includes the close code in `reason`). Browser-initiated
      // close is the expected shutdown path, not a failure.
      Effect.catchTag("SocketError", () => Effect.logInfo("[ws] browser disconnected")),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[ws] browser disconnected")
          : Effect.logError("[ws] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ignore,
    )

    return HttpServerResponse.empty()
  })

const routesLayer = (cfg: RoutesConfig) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/", HttpServerResponse.html(cfg.indexHtml)),
    HttpRouter.add(
      "GET",
      "/client.js",
      HttpServerResponse.text(cfg.clientJs, {
        contentType: "application/javascript; charset=utf-8",
      }),
    ),
    HttpRouter.add("GET", "/ws", wsHandler(cfg)),
  )

// ---------------------------------------------------------------------------
// Bootstrap effect: resolve paths, mkdir cache, bundle client, read HTML,
// launch the HTTP router with the route layer above.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const tracksDir = path.join(flags.cache, flags.music.provider)
  yield* fs.makeDirectory(tracksDir, { recursive: true })

  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "client/index.html"))

  yield* Effect.logInfo(
    `radio-station (${flags.planner.model} planning, ${flags.music.provider} ${flags.music.model} playing)`,
  )
  yield* Effect.logInfo(`tracks cached at: ${tracksDir}`)

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`, so keep returning the
  // launch effect here.
  // @effect-diagnostics-next-line effect/returnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(
      routesLayer({
        brief: flags.brief,
        trackCount: flags.trackCount,
        plannerModel: flags.planner.model,
        musicModel: flags.music.model,
        tracksDir,
        indexHtml,
        clientJs,
      }),
    ),
  ).pipe(
    Effect.provide(
      Layer.merge(musicGeneratorLayer(flags.music), languageModelLayer(flags.planner)),
    ),
  )
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
