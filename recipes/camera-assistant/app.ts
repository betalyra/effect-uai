/**
 * Composition for the camera-assistant recipe: the provider preset, the HTTP
 * routes and the WebSocket bridge.
 *
 * Gemini Live only. Video is a capability marker rather than a common
 * promise, so this is the one realtime provider `recipe.ts` type-checks
 * against; pointing it at OpenAI is a compile error.
 *
 * `run.ts` supplies the platform `HttpServer`, `FileSystem` and `Path`.
 */
import {
  Cause,
  Channel,
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Match,
  Path,
  Queue,
  Schedule,
  Stdio,
  Stream,
} from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import type { ImageSource } from "@effect-uai/core/Image"
import type { CommonSessionRequest } from "@effect-uai/core/Realtime"
import {
  RealtimeSession,
  type RealtimeSessionService,
  RealtimeVideoInput,
} from "@effect-uai/core/RealtimeSession"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { webSearchTool } from "@effect-uai/core/WebSearchTool"
import { GeminiLiveSession, layer as geminiLiveLayer } from "@effect-uai/google/GeminiLiveSession"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { webSearchLayer } from "../_shared/model.js"
import { type AssistantConfig, runAssistant, type StatusEvent } from "./recipe.js"

// Few results: each one is read aloud eventually, and a spoken answer has no
// room for ten.
const toolkit = Toolkit.make(webSearchTool({ maxResults: 3 }))

const INSTRUCTIONS = [
  "You are a voice assistant that can also see, whenever the camera is on.",
  "Speak naturally, one or two short sentences per turn. No lists, no markdown.",
  "",
  "Frames reach you only while the camera is switched on and the person is",
  "speaking, so the most recent ones are what they are looking at now. If they",
  "ask about something in view and you have been shown nothing, say the camera",
  "is off rather than guessing. If a frame is too dark or blurry to make out,",
  "say so and ask them to move closer.",
  "",
  "Questions that are not about the view are ordinary questions. Answer them,",
  "and expect the camera to come on later in the same conversation.",
  "",
  "You have web_search for anything you could not already know, including",
  "looking up something you have just been shown. Say a few words before you",
  "call it so the person is not left in silence, and answer from what you find",
  "in one or two sentences without reading out the links.",
].join("\n")

const PCM = (sampleRate: 16000 | 24000) =>
  ({ container: "raw", encoding: "pcm_s16le", sampleRate, channels: 1 }) as const

const cfg: AssistantConfig = {
  model: "gemini-3.1-flash-live-preview",
  instructions: INSTRUCTIONS,
  voiceId: "Kore",
  inputFormat: PCM(16000),
  outputFormat: PCM(24000),
}

/**
 * The generic tag with this provider's video settings already applied, so
 * `recipe.ts` stays vendor-free while the knobs that make video affordable
 * are still set. Low resolution is 64 tokens a frame instead of 256, and
 * compression is what keeps an audio-plus-video session from running out of
 * context in two minutes.
 */
const videoTuned = Layer.effect(RealtimeSession)(
  Effect.gen(function* () {
    const gemini = yield* GeminiLiveSession
    return {
      open: (request: CommonSessionRequest) =>
        gemini.open({
          ...request,
          mediaResolution: "low",
          turnCoverage: "activity",
          contextCompression: { triggerTokens: 16000 },
        }),
    } satisfies RealtimeSessionService
  }),
)

const sessionLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return Layer.mergeAll(videoTuned, Layer.succeed(RealtimeVideoInput, undefined)).pipe(
      Layer.provide(geminiLiveLayer({ apiKey })),
    )
  }),
)

// ---------------------------------------------------------------------------
// Frame sources. The browser is one; a folder of JPEGs is the other, for
// trying the recipe without pointing a camera at anything.
// ---------------------------------------------------------------------------

const FRAME_INTERVAL = "1 seconds"

/** Read once at startup: a demo folder is small, and this keeps `R` empty. */
const readFrames = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = (yield* fs.readDirectory(dir)).filter((name) => /\.jpe?g$/i.test(name)).sort()
    return yield* Effect.forEach(
      names,
      (name) =>
        Effect.map(fs.readFile(path.join(dir, name)), (bytes): ImageSource => ({
          _tag: "bytes",
          bytes,
          mimeType: "image/jpeg",
        })),
      { concurrency: 4 },
    )
  })

/** Loops, so a short folder still covers a whole conversation. */
const paced = (frames: ReadonlyArray<ImageSource>): Stream.Stream<ImageSource> =>
  Stream.fromIterable(frames).pipe(Stream.forever, Stream.schedule(Schedule.spaced(FRAME_INTERVAL)))

// ---------------------------------------------------------------------------
// WebSocket bridge. Every inbound frame arrives as bytes whatever the browser
// sent, so the client tags each one: PCM contains every byte value, and a
// JPEG is bytes too, so neither can be sniffed.
// ---------------------------------------------------------------------------

const AUDIO_FRAME = 0x00
const TEXT_FRAME = 0x01
const VIDEO_FRAME = 0x02

const decoder = new TextDecoder()

type Flags = {
  readonly source: "camera" | "screen"
  readonly frames: Option.Option<string>
  readonly search: string
}

/** Frames come from the browser, or from a folder that replaces it. */
const wsHandler = (fromDisk: Option.Option<ReadonlyArray<ImageSource>>) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[ws] browser connected")

    const micQueue = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>()
    const typedQueue = yield* Queue.unbounded<string, Cause.Done<void>>()
    const frameQueue = yield* Queue.unbounded<ImageSource, Cause.Done<void>>()
    const outQueue = yield* Queue.unbounded<string | Uint8Array, Cause.Done<void>>()

    const frames = Option.match(fromDisk, {
      onNone: () => Stream.fromQueue(frameQueue),
      onSome: paced,
    })

    yield* runAssistant(cfg, toolkit, {
      mic: Stream.fromQueue(micQueue),
      typed: Stream.fromQueue(typedQueue),
      frames,
      sendStatus: (event: StatusEvent) =>
        Effect.asVoid(Queue.offer(outQueue, JSON.stringify(event))),
      sendAudio: (bytes) => Effect.asVoid(Queue.offer(outQueue, bytes)),
    }).pipe(
      Effect.scoped,
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[assistant] connection teardown")
          : Effect.logError("[assistant] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(Queue.end(outQueue)),
      Effect.forkScoped,
    )

    const onFrame = (buf: Uint8Array): Effect.Effect<void> =>
      Match.value(buf[0]).pipe(
        Match.when(AUDIO_FRAME, () => Effect.asVoid(Queue.offer(micQueue, buf.subarray(1)))),
        Match.when(TEXT_FRAME, () =>
          Effect.asVoid(Queue.offer(typedQueue, decoder.decode(buf.subarray(1)))),
        ),
        Match.when(VIDEO_FRAME, () =>
          Effect.asVoid(
            Queue.offer(frameQueue, {
              _tag: "bytes",
              bytes: buf.subarray(1),
              mimeType: "image/jpeg",
            }),
          ),
        ),
        // An empty or unknown frame is not worth killing the connection over.
        Match.orElse(() => Effect.void),
      )

    yield* Stream.toChannel(Stream.fromQueue(outQueue)).pipe(
      Channel.pipeTo(HttpServerRequest.upgradeChannel<never>()),
      Stream.fromChannel,
      Stream.runForEach(onFrame),
      Effect.catchTag("SocketError", () => Effect.logInfo("[ws] browser disconnected")),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[ws] browser disconnected")
          : Effect.logError("[ws] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(
        Effect.andThen(
          Queue.end(micQueue),
          Effect.andThen(Queue.end(typedQueue), Queue.end(frameQueue)),
        ),
      ),
      Effect.ignore,
    )

    return HttpServerResponse.empty()
  })

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

const js = (body: string) =>
  HttpServerResponse.text(body, { contentType: "application/javascript; charset=utf-8" })

type Assets = {
  readonly flags: Flags
  readonly fromDisk: Option.Option<ReadonlyArray<ImageSource>>
  readonly indexHtml: string
  readonly clientJs: string
  readonly micWorkletJs: string
  readonly playbackWorkletJs: string
}

const routesLayer = (assets: Assets) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/", HttpServerResponse.html(assets.indexHtml)),
    HttpRouter.add("GET", "/client.js", js(assets.clientJs)),
    HttpRouter.add("GET", "/mic-worklet.js", js(assets.micWorkletJs)),
    HttpRouter.add("GET", "/playback-worklet.js", js(assets.playbackWorkletJs)),
    HttpRouter.add(
      "GET",
      "/config",
      HttpServerResponse.text(
        JSON.stringify({
          micSampleRate: cfg.inputFormat.sampleRate,
          playbackSampleRate: cfg.outputFormat.sampleRate,
          source: assets.flags.source,
          // The camera stays off when the frames come from disk.
          capture: Option.isNone(assets.flags.frames),
        }),
        { contentType: "application/json; charset=utf-8" },
      ),
    ),
    HttpRouter.add("GET", "/ws", wsHandler(assets.fromDisk)),
  )

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    source:
      Option.getOrElse(flagValue("source", argv), () => "camera") === "screen"
        ? ("screen" as const)
        : ("camera" as const),
    frames: flagValue("frames", argv),
    search: Option.getOrElse(flagValue("search", argv), () => "exa"),
  }
})

export const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const flags = yield* readFlags

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const micWorkletJs = yield* bundleClient(path.join(recipeDir, "client/mic-worklet.ts"))
  const playbackWorkletJs = yield* bundleClient(path.join(recipeDir, "client/playback-worklet.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "client/index.html"))
  const fromDisk = yield* Effect.transposeOption(Option.map(flags.frames, readFrames))

  yield* Effect.logInfo(
    `camera-assistant (google: ${cfg.model}, voice ${cfg.voiceId}, ${Option.match(flags.frames, {
      onNone: () => flags.source,
      onSome: (dir) => `frames from ${dir}`,
    })})`,
  )

  // @effect-diagnostics-next-line effect/returnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(
      routesLayer({ flags, fromDisk, indexHtml, clientJs, micWorkletJs, playbackWorkletJs }),
    ),
  ).pipe(Effect.provide(Layer.mergeAll(sessionLayer, webSearchLayer(flags.search))))
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
