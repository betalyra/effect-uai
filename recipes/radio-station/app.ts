/**
 * Runtime-agnostic composition of the radio-station recipe.
 *
 * Everything that doesn't depend on Bun / Node / Deno lives here:
 *   - provider selection from argv (Match dispatch over `--provider`)
 *   - provider service layers (ElevenLabs Music, Google Lyria, OpenAI
 *     Responses) and their HTTP client
 *   - recipe config (`STATION_BRIEF`, `TRACK_COUNT`, model overrides)
 *   - HTTP routes (`/`, `/client.js`, `/ws`) and the WebSocket handler
 *   - the bootstrap `main` effect: read paths, ensure cache dir,
 *     bundle the browser client, read the static HTML, launch the
 *     HTTP router
 *   - logger + log-level layer
 *
 * Each runner (`run-bun.ts`, `run-node.ts`, ...) provides only the
 * three platform pieces: `HttpServer`, `FileSystem`, `Path`, then
 * calls the matching `XxxRuntime.runMain(main.pipe(Effect.provide(...)))`.
 */
import {
  Cause,
  Channel,
  Config,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Match,
  Option,
  Path,
  Queue,
  References,
  Stream,
} from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { layer as elevenlabsMusicLayer } from "@effect-uai/elevenlabs/ElevenLabsMusicGenerator"
import { layer as lyriaLayer } from "@effect-uai/google/LyriaGenerator"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { providerFlag } from "../_shared/argv.js"
import { bundleClient } from "../_shared/bundle.js"
import { runStation, type ServerEvent } from "./recipe.js"

// ---------------------------------------------------------------------------
// Provider selection. `--provider=google|elevenlabs` (default elevenlabs).
// Both register the generic `MusicGenerator` service tag, so the recipe
// body in recipe.ts doesn't change.
// ---------------------------------------------------------------------------

export type Provider = "elevenlabs" | "google"

const decodeProvider = (raw: string): Provider => {
  const v = raw.toLowerCase()
  if (v === "google" || v === "lyria") return "google"
  if (v === "elevenlabs" || v === "eleven") return "elevenlabs"
  throw new Error(`unknown provider: ${raw} (expected: elevenlabs | google)`)
}

export const provider: Provider = Option.getOrElse(
  providerFlag(decodeProvider),
  (): Provider => "elevenlabs",
)

const defaultMusicModel = {
  elevenlabs: "music_v1",
  google: "lyria-3-clip-preview",
} as const

const musicLayerFor = Match.type<Provider>().pipe(
  Match.when("elevenlabs", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY")
        return elevenlabsMusicLayer({ apiKey })
      }),
    ),
  ),
  Match.when("google", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
        return lyriaLayer({ apiKey })
      }),
    ),
  ),
  Match.exhaustive,
)

// Provider layers don't bake in an `HttpClient` — each runner provides
// its own (FetchHttpClient under Bun, NodeHttpClient.layerUndici under
// Node, etc.) since Node's native fetch has known SSE-streaming issues.
const providerLayers = Layer.mergeAll(
  musicLayerFor(provider),
  Layer.unwrap(
    Effect.gen(function* () {
      const openaiKey = yield* Config.redacted("OPENAI_API_KEY")
      return responsesLayer({ apiKey: openaiKey })
    }),
  ),
)

// ---------------------------------------------------------------------------
// Recipe config (env-driven via Config).
// ---------------------------------------------------------------------------

const recipeConfig = Config.all({
  brief: Config.string("STATION_BRIEF").pipe(
    Config.withDefault("late-night lo-fi study session, mellow and instrumental"),
  ),
  trackCount: Config.int("TRACK_COUNT").pipe(Config.withDefault(10)),
  plannerModel: Config.string("PLANNER_MODEL").pipe(Config.withDefault("gpt-5.4-mini")),
  musicModel: Config.string("MUSIC_MODEL").pipe(Config.withDefault(defaultMusicModel[provider])),
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
  const cfg = yield* recipeConfig
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const tracksDir = path.join(recipeDir, "tracks", provider)
  yield* fs.makeDirectory(tracksDir, { recursive: true })

  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "client/index.html"))

  yield* Effect.logInfo(`radio-station (responses + ${provider} music: ${cfg.musicModel})`)
  yield* Effect.logInfo(`tracks cached at: ${tracksDir}`)

  return Layer.launch(
    HttpRouter.serve(
      routesLayer({
        brief: cfg.brief,
        trackCount: cfg.trackCount,
        plannerModel: cfg.plannerModel,
        musicModel: cfg.musicModel,
        tracksDir,
        indexHtml,
        clientJs,
      }),
    ),
  )
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)

// ---------------------------------------------------------------------------
// App-level layer: everything that's NOT platform-specific. Runners
// merge this with their platform layers (`HttpServer`, `FileSystem`,
// `Path`) and call `XxxRuntime.runMain`.
// ---------------------------------------------------------------------------

const logLevelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
    return Layer.succeed(References.MinimumLogLevel, level)
  }),
)

export const appLayer = Layer.mergeAll(
  providerLayers,
  Logger.layer([Logger.consolePretty()]),
  logLevelLayer,
)
