/**
 * Runtime-agnostic composition of the radio-station recipe.
 *
 * Everything that doesn't depend on Bun / Node / Deno lives here: the flags
 * (`--music-model`, `--planner-model`, `--brief`, `--tracks`, `--cache`),
 * the station's host, the HTTP routes and the bootstrap `main`. `run.ts`
 * supplies the platform `HttpServer`, `FileSystem` and `Path`.
 *
 * Both music providers register the generic `MusicGenerator` tag, so
 * `--music-model google:lyria-3-clip-preview` changes only the Layer and
 * `recipe.ts` is untouched.
 */
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  PubSub,
  Schema,
  Stdio,
  Stream,
  SubscriptionRef,
} from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { cacheDir } from "@effect-uai/recipe-kit/output"
import * as Run from "@effect-uai/ui/Run"
import { type Envelope, StreamId } from "@effect-uai/ui/RunEvent"
import * as SseEncoding from "@effect-uai/ui/SseEncoding"
import { languageModelLayer, musicGeneratorLayer, parseModelSpec } from "../_shared/model.js"
import { ListeningBody, StationUi, StatusResponse } from "./contract.js"
import { type RunStationConfig, runStation } from "./recipe.js"

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
// The station's host: the station runs here, not in a listener's request.
//
// It lives as long as the server, so a reload or a closed tab stops
// nothing. What a listener is told goes into a PubSub that replays from the
// start (the durable-chat shape): a reloaded page gets the whole set and
// resumes at the track the listener had reached.
// ---------------------------------------------------------------------------

type Host = {
  readonly streamId: StreamId
  /** Start the station. Only the first press does anything. */
  readonly play: Effect.Effect<void>
  readonly playing: Effect.Effect<boolean>
  /** A listener started track `index`. */
  readonly listen: (index: number) => Effect.Effect<void>
  /** The station's envelopes after `after`: replay, then live. */
  readonly events: (after: number) => Stream.Stream<Envelope>
}

/** What a listener is told when the station cannot go on: the error's tag, the details are in the log. */
const stopped = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  const reason =
    Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : "error"
  return Effect.logError("[station] stopped", { cause: Cause.pretty(cause) }).pipe(
    Effect.andThen(Effect.orDie(StationUi.live("problem", reason))),
  )
}

const makeHost = (cfg: Omit<RunStationConfig, "listening">, streamId: StreamId) =>
  Effect.gen(function* () {
    const pressed = yield* Deferred.make<void>()
    const listening = yield* SubscriptionRef.make(-1)
    const events = yield* PubSub.unbounded<Envelope>({ replay: Number.POSITIVE_INFINITY })

    // Where a listener is goes on the stream too, so a reload resumes there.
    const position = SubscriptionRef.changes(listening).pipe(
      Stream.filter((index) => index >= 0),
      Stream.mapEffect((index) => Effect.orDie(StationUi.live("listening", index))),
    )

    // Waits for Start, then runs the station in the host's scope. `seq` is
    // numbered once here, so it can never repeat on this stream.
    yield* Stream.fromEffect(Deferred.await(pressed)).pipe(
      Stream.flatMap(() => Stream.merge(runStation({ ...cfg, listening }), position)),
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
      // Only ever forward: a second tab further back does not hold the station back.
      listen: (index) => SubscriptionRef.update(listening, (at) => Math.max(at, index)),
      events: (after) =>
        Stream.fromPubSub(events).pipe(Stream.filter((envelope) => envelope.seq > after)),
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
//   POST /listening       { index }: a listener started that track
//   GET  /events          SSE: the set, replay then live
//   GET  /tracks/:file    one finished track
// ---------------------------------------------------------------------------

type RoutesConfig = {
  readonly tracksDir: string
  readonly indexHtml: string
  readonly clientJs: string
  readonly host: Host
}

const status = (host: Host) =>
  Effect.flatMap(host.playing, (playing) =>
    HttpServerResponse.schemaJson(StatusResponse)({ streamId: host.streamId, playing }),
  ).pipe(Effect.orDie)

const listeningHandler = (host: Host) =>
  HttpServerRequest.schemaBodyJson(ListeningBody).pipe(
    Effect.flatMap(({ index }) => host.listen(index)),
    Effect.as(HttpServerResponse.empty({ status: 204 })),
    Effect.catchTag("SchemaError", () => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
    Effect.orDie,
  )

const EventParams = Schema.Struct({
  // A reconnect's `Last-Event-ID` wins: EventSource reuses the original URL.
  after: Schema.optionalKey(Schema.FiniteFromString.check(Schema.isInt())),
})

const eventsHandler = (host: Host) =>
  Effect.gen(function* () {
    const { after } = yield* HttpServerRequest.schemaSearchParams(EventParams)
    const request = yield* HttpServerRequest.HttpServerRequest
    const from = SseEncoding.lastEventId(request.headers).pipe(Option.getOrElse(() => after ?? 0))
    // A comment every 15 s keeps proxies from closing a stream that sits idle before Start.
    const body = host.events(from).pipe(SseEncoding.encode, SseEncoding.heartbeat("15 seconds"))
    return HttpServerResponse.stream(body, {
      headers: { ...SseEncoding.responseHeaders, "x-accel-buffering": "no" },
    })
  }).pipe(
    Effect.catchTag("SchemaError", () => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
  )

/** Only the track files the station writes, so the route cannot read anything else. */
const TRACK_FILE = /^track-\d+\.mp3$/

const trackHandler = (cfg: RoutesConfig) =>
  Effect.gen(function* () {
    const { file } = yield* HttpRouter.params
    const fs = yield* FileSystem.FileSystem
    const path = `${cfg.tracksDir}/${file}`
    const found =
      file !== undefined &&
      TRACK_FILE.test(file) &&
      (yield* Effect.orElseSucceed(fs.exists(path), () => false))
    return found
      ? HttpServerResponse.stream(fs.stream(path), { contentType: "audio/mpeg" })
      : HttpServerResponse.empty({ status: 404 })
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
    HttpRouter.add("GET", "/status", status(cfg.host)),
    HttpRouter.add("POST", "/play", Effect.andThen(cfg.host.play, status(cfg.host))),
    HttpRouter.add("POST", "/listening", listeningHandler(cfg.host)),
    HttpRouter.add("GET", "/events", eventsHandler(cfg.host)),
    HttpRouter.add("GET", "/tracks/:file", trackHandler(cfg)),
  )

// ---------------------------------------------------------------------------
// Bootstrap
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

  // The host is scoped to the served layer, so the station lives as long as the server.
  const routes = Layer.unwrap(
    Effect.map(
      makeHost(
        {
          brief: flags.brief,
          trackCount: flags.trackCount,
          tracksDir,
          plannerModel: flags.planner.model,
          musicModel: flags.music.model,
        },
        // One stream per server run, so a page left open from the last run starts over.
        StreamId.make(`radio-${yield* Clock.currentTimeMillis}`),
      ),
      (host) => routesLayer({ tracksDir, indexHtml, clientJs, host }),
    ),
  )

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`, so keep returning the
  // launch effect here.
  // @effect-diagnostics-next-linereturnEffectInGen:off
  return Layer.launch(HttpRouter.serve(routes)).pipe(
    Effect.provide(
      Layer.merge(musicGeneratorLayer(flags.music), languageModelLayer(flags.planner)),
    ),
  )
}).pipe(
  Effect.flatten,
  // The error itself, fields included: a provider's `raw` body says why it refused.
  Effect.tapError((error) => Effect.logError("[main] failed", error)),
  Effect.tapDefect((defect) => Effect.logError("[main] crashed", defect)),
)
