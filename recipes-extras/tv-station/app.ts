/**
 * Runtime-agnostic composition of the tv-station recipe.
 *
 * Flags, the manifest's lifetime, the HTTP routes and the bootstrap
 * `main` live here; `run.ts` supplies the platform `HttpServer`,
 * `FileSystem` and `Path`.
 *
 * Nothing generates until a WebSocket connects. Booting reads the
 * manifest and serves the page, and that is all.
 */
import {
  Array as Arr,
  Cause,
  Channel,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Queue,
  Ref,
  Stdio,
  Stream,
} from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { boolFlag, flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { cacheDir } from "@effect-uai/recipe-kit/output"
import {
  imageGeneratorLayer,
  languageModelLayer,
  parseModelSpec,
  videoGeneratorLayer,
  webSearchLayer,
} from "./model.js"
import type { WebSearch } from "@effect-uai/core/WebSearch"
import { planChannel, research } from "./planner.js"
import { type LiveStation, type ServerEvent, planNext, runStation } from "./recipe.js"
import * as Station from "./station.js"
import { assemble, registerCodecs } from "./stream.js"

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const fs = yield* FileSystem.FileSystem
  const briefFile = flagValue("brief-file", argv)
  const fromFile: Option.Option<string> = yield* Option.match(briefFile, {
    onNone: () => Effect.succeedNone as Effect.Effect<Option.Option<string>>,
    onSome: (path) => Effect.asSome(Effect.orDie(fs.readFileString(path))),
  })
  return {
    // A file wins over the inline flag: it is the one you edit between runs.
    brief: Option.orElse(fromFile, () => flagValue("brief", argv)),
    budgetSeconds: intFlag("budget", argv, 30),
    clipSeconds: intFlag("clip", argv, 6),
    search: boolFlag("search", argv),
    fresh: boolFlag("fresh", argv),
    // On by default: a channel that stops after one pass is not a channel.
    loop: boolFlag("loop", argv, true),
    infinite: boolFlag("infinite", argv),
    dryRun: boolFlag("dry-run", argv),
    // Replay what the newest station already rendered, generating nothing.
    rehearse: boolFlag("rehearse", argv),
    planner: parseModelSpec(
      Option.getOrElse(flagValue("planner-model", argv), () => "gpt-5.4-mini"),
      "openai",
    ),
    video: parseModelSpec(
      Option.getOrElse(flagValue("video-model", argv), () => "minimax/h3-max-turbo/text-to-video"),
      "fal",
    ),
    // Only the standby card, so the cheapest fast endpoint will do.
    image: parseModelSpec(
      Option.getOrElse(flagValue("image-model", argv), () => "fal-ai/flux/schnell"),
      "fal",
    ),
    searchProvider: Option.getOrElse(flagValue("search-provider", argv), () => "exa"),
    cache: cacheDir("tv-station", argv),
  }
})

type Flags = Effect.Success<typeof readFlags>

// ---------------------------------------------------------------------------
// The station: resumed from the manifest, or planned fresh.
// ---------------------------------------------------------------------------

const planStation = (flags: Flags) =>
  Effect.gen(function* () {
    const none = Effect.succeedNone as Effect.Effect<Option.Option<string>, never, WebSearch>
    const briefing = yield* Option.match(flags.brief, {
      onNone: () => none,
      onSome: (brief) =>
        flags.search ? Effect.asSome(research(brief, flags.planner.model)) : none,
    })
    const plan = yield* planChannel(flags.brief, briefing, flags.planner.model)
    return {
      channel: plan.channel,
      tagline: plan.tagline,
      card: plan.card,
      ...Option.match(flags.brief, { onNone: () => ({}), onSome: (brief) => ({ brief }) }),
      budgetSeconds: flags.budgetSeconds,
      clipSeconds: flags.clipSeconds,
      model: flags.video.model,
      clips: [],
    } satisfies Station.Station
  })

/** `2026-09-19T20-08-18`: sortable, so the newest directory is the last one. */
const stamp = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(now).slice(0, 19).replaceAll(":", "-"),
)

const STAMPED = /^\d{4}-\d{2}-\d{2}T/

/**
 * Each station gets its own dated directory, so `--fresh` starts beside
 * the last one rather than over it: clips already paid for stay playable.
 * Resuming takes the newest.
 */
const stationDir = (
  fresh: boolean,
  root: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const fresh_ = `${root}/${yield* stamp}`
    if (fresh) return fresh_
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const stations = Arr.sort(
      entries.filter((entry) => STAMPED.test(entry)),
      Order.String,
    )
    return Option.match(Arr.last(stations), {
      onNone: () => fresh_,
      onSome: (name) => `${root}/${name}`,
    })
  })

const loadStation = (flags: Flags, manifest: string) =>
  Effect.flatMap(
    Station.read(manifest),
    Option.match({
      onNone: () => planStation(flags),
      onSome: (station) =>
        Effect.as(
          Effect.logInfo(`resuming "${station.channel}" (${station.clips.length} clips planned)`),
          station,
        ),
    }),
  )

// ---------------------------------------------------------------------------
// HTTP + WebSocket routes.
//
//   GET /                static HTML shell
//   GET /client.js       bundled browser ESM
//   GET /stream          the channel: one fragmented MP4, held open
//   GET /programme.mp4   every clip so far as one ordinary file
//   GET /ws              upgrade, and only then start generating
//
// `/ws` and `/stream` are two connections onto one station, so the
// station is created once and both attach to it. The socket owns its
// lifetime: closing the page stops the generator and the timeline.
// ---------------------------------------------------------------------------

type RoutesConfig = {
  readonly station: Station.Station
  readonly manifest: string
  readonly clipsDir: string
  readonly plannerModel: string
  readonly imageModel: string
  readonly infinite: boolean
  readonly loop: boolean
  readonly rehearse: boolean
  readonly indexHtml: string
  readonly clientJs: string
  /** The running station, if someone has pressed play. */
  readonly live: Ref.Ref<Option.Option<LiveStation>>
}

const encodeFrame = (event: ServerEvent): string => JSON.stringify(event)

const wsHandler = (cfg: RoutesConfig) =>
  Effect.gen(function* () {
    const taken = yield* Ref.get(cfg.live)
    if (Option.isSome(taken)) {
      yield* Effect.logInfo("[ws] refused: the station already has a viewer")
      return HttpServerResponse.empty({ status: 409 })
    }
    yield* Effect.logInfo("[ws] viewer connected")

    const station = yield* runStation({
      station: cfg.station,
      manifest: cfg.manifest,
      clipsDir: cfg.clipsDir,
      plannerModel: cfg.plannerModel,
      imageModel: cfg.imageModel,
      infinite: cfg.infinite,
      loop: cfg.loop,
      rehearse: cfg.rehearse,
    })
    yield* Ref.set(cfg.live, Option.some(station))

    yield* Stream.toChannel(Stream.map(station.events, encodeFrame)).pipe(
      Channel.pipeTo(HttpServerRequest.upgradeChannel<never>()),
      Stream.fromChannel,
      Stream.runDrain,
      // Effect's `Socket` reports every WS close as an error; a browser
      // closing the tab is the expected shutdown path.
      Effect.catchTag("SocketError", () => Effect.logInfo("[ws] viewer disconnected")),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[ws] viewer disconnected")
          : Effect.logError("[ws] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ignore,
      Effect.ensuring(Ref.set(cfg.live, Option.none())),
    )

    return HttpServerResponse.empty()
  })

/** The one form a browser sends for a media stream: from here to the end. */
const RANGE = /^bytes=(\d+)-$/

/** How much a range response claims to cover. The stream has no end; the browser asks again. */
const WINDOW = 2 ** 32

/**
 * The channel itself: fragmented MP4, so the browser plays it as it
 * arrives and never waits for an end that is not coming.
 *
 * A browser treats a media URL as a file: it closes the connection when
 * it has read far enough ahead and asks for the rest by byte range, so
 * every request is answered from wherever it asks to start.
 */
const streamHandler = (cfg: RoutesConfig) =>
  Effect.gen(function* () {
    const live = yield* Ref.get(cfg.live)
    if (Option.isNone(live)) return HttpServerResponse.empty({ status: 503 })
    const request = yield* HttpServerRequest.HttpServerRequest
    const from = Option.flatMap(Option.fromNullishOr(request.headers["range"]), (range) =>
      Option.map(Option.fromNullishOr(RANGE.exec(range)?.[1]), Number),
    )
    return Option.match(from, {
      onNone: () =>
        HttpServerResponse.stream(live.value.tap(0), {
          contentType: "video/mp4",
          headers: { "accept-ranges": "bytes" },
        }),
      onSome: (at) =>
        HttpServerResponse.stream(live.value.tap(at), {
          status: 206,
          contentType: "video/mp4",
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes ${at}-${at + WINDOW - 1}/*`,
          },
        }),
    })
  })

/**
 * Everything rendered so far, joined into one ordinary seekable file.
 * Built on request rather than kept, because it is derived from clips
 * that are already on disk.
 */
const programmeHandler = (cfg: RoutesConfig) =>
  Effect.gen(function* () {
    const station = yield* Effect.flatMap(Station.read(cfg.manifest), (read) =>
      Effect.succeed(Option.getOrElse(read, () => cfg.station)),
    )
    const files = station.clips.flatMap((clip) =>
      clip.state._tag === "done" ? [`${cfg.clipsDir}/${clip.state.file}`] : [],
    )
    if (files.length === 0) return HttpServerResponse.empty({ status: 404 })
    return yield* Effect.map(assemble(files), (bytes) =>
      HttpServerResponse.uint8Array(bytes, { contentType: "video/mp4" }),
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logError("[programme] failed", { cause: Cause.pretty(cause) }),
        HttpServerResponse.empty({ status: 500 }),
      ),
    ),
  )

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
    HttpRouter.add("GET", "/stream", streamHandler(cfg)),
    HttpRouter.add("GET", "/programme.mp4", programmeHandler(cfg)),
    HttpRouter.add("GET", "/ws", wsHandler(cfg)),
  )

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const estimate = (flags: Flags): string =>
  flags.infinite
    ? "unbounded (--infinite)"
    : `${flags.budgetSeconds}s in ${Math.floor(flags.budgetSeconds / flags.clipSeconds)} clips`

export const main = Effect.gen(function* () {
  yield* registerCodecs
  const flags = yield* readFlags
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const clipsDir = yield* stationDir(flags.fresh, path.join(flags.cache, flags.video.provider))
  const manifest = path.join(clipsDir, "station.json")
  yield* fs.makeDirectory(clipsDir, { recursive: true })

  const layers = Layer.mergeAll(
    videoGeneratorLayer(flags.video),
    imageGeneratorLayer(flags.image),
    languageModelLayer(flags.planner),
    webSearchLayer(flags.searchProvider),
  )

  const station = yield* Effect.provide(loadStation(flags, manifest), layers)
  yield* Effect.logInfo(`tv-station: "${station.channel}" (${station.tagline})`)
  yield* Effect.logInfo(`budget ${estimate(flags)}, clips at ${clipsDir}`)

  if (flags.dryRun) {
    // Plan the opening block too: the segment prompts are what the video
    // model actually sees, so a dry run that stops at the channel name
    // shows none of what you would be paying for.
    const clips = yield* Effect.provide(
      planNext(station, flags.planner.model, flags.infinite),
      layers,
    )
    yield* Station.write(manifest, Station.withClips(station, clips))
    yield* Effect.forEach(
      clips,
      (clip) => Effect.logInfo(`  ${clip.index + 1}. [${clip.kind ?? "segment"}] ${clip.title}`),
      { discard: true },
    )
    return Effect.logInfo(`--dry-run: manifest written to ${manifest}, nothing submitted`)
  }

  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "client/index.html"))
  const live = yield* Ref.make(Option.none<LiveStation>())

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`.
  // @effect-diagnostics-next-line effect/returnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(
      routesLayer({
        station,
        manifest,
        clipsDir,
        plannerModel: flags.planner.model,
        imageModel: flags.image.model,
        infinite: flags.infinite,
        loop: flags.loop,
        rehearse: flags.rehearse,
        indexHtml,
        clientJs,
        live,
      }),
    ),
  ).pipe(Effect.provide(layers))
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
