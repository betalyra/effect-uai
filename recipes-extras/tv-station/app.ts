/**
 * Runtime-agnostic composition of the tv-station recipe.
 *
 * Flags, the manifest's lifetime, the HTTP routes and the bootstrap
 * `main` live here; `run.ts` supplies the platform `HttpServer`,
 * `FileSystem` and `Path`.
 *
 * Nothing generates until someone presses Play. Booting reads the
 * manifest and serves the page, and that is all.
 */
import {
  Array as Arr,
  Cause,
  Data,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Predicate,
  PubSub,
  Ref,
  Schema,
  Stdio,
  Stream,
} from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { boolFlag, flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { cacheDir } from "@effect-uai/recipe-kit/output"
import * as Run from "@effect-uai/ui/Run"
import { type Envelope, StreamId } from "@effect-uai/ui/RunEvent"
import * as SseEncoding from "@effect-uai/ui/SseEncoding"
import { StationUi, StatusResponse } from "./contract.js"
import {
  imageGeneratorLayer,
  languageModelLayer,
  parseModelSpec,
  videoGeneratorLayer,
  webSearchLayer,
} from "./model.js"
import type { WebSearch } from "@effect-uai/core/WebSearch"
import { planChannel, research } from "./planner.js"
import { type LiveStation, type RunStationConfig, planNext, runStation } from "./recipe.js"
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
    const station: Station.Station = {
      channel: plan.channel,
      tagline: plan.tagline,
      card: plan.card,
      ...Option.match(flags.brief, { onNone: () => ({}), onSome: (brief) => ({ brief }) }),
      budgetSeconds: flags.budgetSeconds,
      clipSeconds: flags.clipSeconds,
      model: flags.video.model,
      clips: [],
    }
    return station
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

/** `--rehearse` replays what is on disk; with nothing there it must not plan, which costs. */
export class NothingToRehearse extends Data.TaggedError("NothingToRehearse")<{
  readonly manifest: string
}> {
  override get message() {
    return `--rehearse found no station at ${this.manifest}; point --cache at a cache with rendered clips`
  }
}

const loadStation = (flags: Flags, manifest: string) =>
  Station.read(manifest).pipe(
    Effect.filterOrFail(
      (read) => !flags.rehearse || Option.isSome(read),
      () => new NothingToRehearse({ manifest }),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => planStation(flags),
        onSome: (station) =>
          Effect.as(
            Effect.logInfo(`resuming "${station.channel}" (${station.clips.length} clips planned)`),
            station,
          ),
      }),
    ),
  )

// ---------------------------------------------------------------------------
// The station's host: the station runs here, not in a viewer's request.
//
// It lives as long as the server, so closing a tab stops nothing and every
// tab sees the same channel. What a viewer is told goes into a PubSub that
// replays from the start (the durable-chat shape): a tab that opens late,
// or reloads, gets the whole listing and then follows live.
// ---------------------------------------------------------------------------

type Host = {
  readonly streamId: StreamId
  /** Start the station. Only the first press does anything. */
  readonly play: Effect.Effect<void>
  readonly playing: Effect.Effect<boolean>
  /** The station's envelopes after `after`: replay, then live. */
  readonly events: (after: number) => Stream.Stream<Envelope>
  /** The picture, once the station is running. */
  readonly live: Effect.Effect<Option.Option<LiveStation>>
}

/** What a viewer is told when the station cannot go on: the error's tag, the details are in the log. */
const stopped = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  const reason =
    Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : "error"
  return Effect.logError("[station] stopped", { cause: Cause.pretty(cause) }).pipe(
    Effect.andThen(Effect.orDie(StationUi.live("problem", reason))),
  )
}

/**
 * `load` plans the channel (or reads it back), so nothing is spent and the
 * page is up before anyone presses Play.
 */
const makeHost = <E, R>(load: Effect.Effect<RunStationConfig, E, R>, streamId: StreamId) =>
  Effect.gen(function* () {
    const pressed = yield* Deferred.make<void>()
    const live = yield* Ref.make(Option.none<LiveStation>())
    const events = yield* PubSub.unbounded<Envelope>({ replay: Number.POSITIVE_INFINITY })

    // Waits for Play, then runs the station in the host's scope. `seq` is
    // numbered once here, so it can never repeat on this stream.
    yield* Stream.fromEffect(Effect.andThen(Deferred.await(pressed), load)).pipe(
      Stream.flatMap((cfg) =>
        Stream.unwrap(
          runStation(cfg).pipe(
            Effect.tap((station) => Ref.set(live, Option.some(station))),
            Effect.map((station) => station.events),
          ),
        ),
      ),
      Stream.catchCause((cause) => Stream.fromEffect(stopped(cause))),
      Run.streamScoped,
      Run.sequenceOwned(streamId),
      Stream.runForEach((envelope) => PubSub.publish(events, envelope)),
      Effect.forkScoped,
    )

    const host: Host = {
      streamId,
      play: Effect.asVoid(Deferred.succeed(pressed, undefined)),
      playing: Deferred.isDone(pressed),
      events: (after) =>
        Stream.fromPubSub(events).pipe(Stream.filter((envelope) => envelope.seq > after)),
      live: Ref.get(live),
    }
    return host
  })

// ---------------------------------------------------------------------------
// HTTP routes.
//
//   GET  /                static HTML shell
//   GET  /client.js       bundled browser ESM
//   GET  /status          { streamId, playing }
//   POST /play            start the station (once); answers like /status
//   GET  /events          SSE: what is happening, replay then live
//   GET  /stream          the channel: one fragmented MP4, held open
//   GET  /clips/:file     one finished clip
//   GET  /programme.mp4   every clip so far as one ordinary file
// ---------------------------------------------------------------------------

type RoutesConfig = {
  readonly manifest: string
  readonly clipsDir: string
  readonly indexHtml: string
  readonly clientJs: string
  readonly host: Host
}

const status = (host: Host) =>
  Effect.flatMap(host.playing, (playing) =>
    HttpServerResponse.schemaJson(StatusResponse)({ streamId: host.streamId, playing }),
  ).pipe(Effect.orDie)

const EventParams = Schema.Struct({
  // A reconnect's `Last-Event-ID` wins: EventSource reuses the original URL.
  after: Schema.optionalKey(Schema.FiniteFromString.check(Schema.isInt())),
})

const eventsHandler = (host: Host) =>
  Effect.gen(function* () {
    const { after } = yield* HttpServerRequest.schemaSearchParams(EventParams)
    const request = yield* HttpServerRequest.HttpServerRequest
    const from = SseEncoding.lastEventId(request.headers).pipe(Option.getOrElse(() => after ?? 0))
    // A comment every 15 s keeps proxies from closing a stream that sits idle before Play.
    const body = host.events(from).pipe(SseEncoding.encode, SseEncoding.heartbeat("15 seconds"))
    return HttpServerResponse.stream(body, {
      headers: { ...SseEncoding.responseHeaders, "x-accel-buffering": "no" },
    })
  }).pipe(
    Effect.catchTag("SchemaError", () => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
  )

/** Only the clip files the station writes, so the route cannot read anything else. */
const CLIP_FILE = /^clip-\d+\.mp4$/

const clipHandler = (cfg: RoutesConfig) =>
  Effect.gen(function* () {
    const { file } = yield* HttpRouter.params
    const fs = yield* FileSystem.FileSystem
    const path = `${cfg.clipsDir}/${file}`
    const found =
      file !== undefined &&
      CLIP_FILE.test(file) &&
      (yield* Effect.orElseSucceed(fs.exists(path), () => false))
    return found
      ? HttpServerResponse.stream(fs.stream(path), { contentType: "video/mp4" })
      : HttpServerResponse.empty({ status: 404 })
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
    const live = yield* cfg.host.live
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
    const station = yield* Station.read(cfg.manifest)
    const files = Option.match(station, {
      onNone: () => [],
      onSome: (s) =>
        s.clips.flatMap((clip) =>
          clip.state._tag === "done" ? [`${cfg.clipsDir}/${clip.state.file}`] : [],
        ),
    })
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
    HttpRouter.add("GET", "/status", status(cfg.host)),
    HttpRouter.add("POST", "/play", Effect.andThen(cfg.host.play, status(cfg.host))),
    HttpRouter.add("GET", "/events", eventsHandler(cfg.host)),
    HttpRouter.add("GET", "/stream", streamHandler(cfg)),
    HttpRouter.add("GET", "/clips/:file", clipHandler(cfg)),
    HttpRouter.add("GET", "/programme.mp4", programmeHandler(cfg)),
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

  yield* Effect.logInfo(`budget ${estimate(flags)}, clips at ${clipsDir}`)
  // A rehearsal with nothing on disk fails here, not after Play.
  if (flags.rehearse) {
    yield* Station.read(manifest).pipe(
      Effect.filterOrFail(Option.isSome, () => new NothingToRehearse({ manifest })),
    )
  }

  const load = loadStation(flags, manifest).pipe(
    Effect.tap((station) =>
      Effect.logInfo(`tv-station: "${station.channel}" (${station.tagline})`),
    ),
  )

  if (flags.dryRun) {
    const station = yield* Effect.provide(load, layers)
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

  // The host is scoped to the served layer, so the station lives exactly as
  // long as the server. Its stream id is the station's directory, so a
  // `--fresh` station is a new stream and a tab never mixes two of them.
  const routes = Layer.unwrap(
    Effect.map(
      makeHost(
        Effect.map(load, (station): RunStationConfig => ({
          station,
          manifest,
          clipsDir,
          plannerModel: flags.planner.model,
          imageModel: flags.image.model,
          infinite: flags.infinite,
          loop: flags.loop,
          rehearse: flags.rehearse,
        })),
        StreamId.make(path.basename(clipsDir)),
      ),
      (host) => routesLayer({ manifest, clipsDir, indexHtml, clientJs, host }),
    ),
  )

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`.
  // @effect-diagnostics-next-line effect/returnEffectInGen:off
  return Layer.launch(HttpRouter.serve(routes)).pipe(Effect.provide(layers))
}).pipe(
  Effect.flatten,
  // The error itself, fields included: a provider's `raw` body says why it refused.
  Effect.tapError((error) => Effect.logError("[main] failed", error)),
  Effect.tapDefect((defect) => Effect.logError("[main] crashed", defect)),
)
