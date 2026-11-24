/**
 * Composition for the camera-assistant recipe: the provider preset, the HTTP
 * routes and the live session.
 *
 * Gemini Live only. Video is a capability marker rather than a common
 * promise, so this is the one realtime provider `recipe.ts` type-checks
 * against; pointing it at OpenAI is a compile error.
 *
 * `run.ts` supplies the platform `HttpServer`, `FileSystem` and `Path`.
 */
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Stdio,
  Stream,
} from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Frame from "@effect-uai/ui/Frame"
import * as LiveSocket from "@effect-uai/ui/LiveSocket"
import type * as Run from "@effect-uai/ui/Run"
import { StreamId } from "@effect-uai/ui/RunEvent"
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
import { Up } from "./contract.js"
import { type AssistantConfig, type Frames, jpeg, runAssistant } from "./recipe.js"

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
  model: "gemini-3.8-live",
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
    const apiKey = yield* Config.Redacted("GOOGLE_API_KEY")
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
      (name) => Effect.map(fs.readFile(path.join(dir, name)), jpeg),
      { concurrency: 4 },
    )
  })

/** Loops, so a short folder still covers a whole conversation. */
const paced = (frames: ReadonlyArray<ImageSource>): Stream.Stream<ImageSource> =>
  Stream.fromIterable(frames).pipe(Stream.forever, Stream.schedule(Schedule.spaced(FRAME_INTERVAL)))

// ---------------------------------------------------------------------------
// The live session. Frames come from the page's camera, or from a folder
// that replaces it (and then the page offers no camera). A session failure
// ends it with a `problem`.
// ---------------------------------------------------------------------------

const session = (frames: Frames) =>
  LiveSocket.handle({
    up: Up,
    handler: (up) =>
      runAssistant(cfg, toolkit, frames, up).pipe(
        Stream.catch((error) =>
          Stream.make(
            Frame.message<Run.Owned>({
              event: { type: "live", name: "problem", value: error._tag },
            }),
          ),
        ),
        Frame.sequence(StreamId.make("camera")),
      ),
  })

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

const js = (body: string) =>
  HttpServerResponse.text(body, { contentType: "application/javascript; charset=utf-8" })

type Assets = {
  readonly frames: Frames
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
    HttpRouter.add("GET", "/ws", session(assets.frames)),
  )

// The `@effect-uai/ui` audio worklets, served at the paths the client passes to `Media`.
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

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

// A typo in `--source` fails at startup instead of quietly meaning "camera".
const decodeSource = Schema.decodeUnknownEffect(Schema.Literals(["camera", "screen"]))

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    source: yield* decodeSource(Option.getOrElse(flagValue("source", argv), () => "camera")),
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
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "client/index.html"))
  const worklets = yield* readWorklets(["mic", "player"])
  const fromDisk = yield* Effect.transposeOption(Option.map(flags.frames, readFrames))
  const frames = Option.match(fromDisk, {
    onNone: (): Frames => ({ _tag: "page", source: flags.source }),
    onSome: (stills): Frames => ({ _tag: "own", frames: paced(stills) }),
  })

  yield* Effect.logInfo(
    `camera-assistant (google: ${cfg.model}, voice ${cfg.voiceId}, ${Option.match(flags.frames, {
      onNone: () => flags.source,
      onSome: (dir) => `frames from ${dir}`,
    })})`,
  )

  // @effect-diagnostics-next-linereturnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(routesLayer({ frames, indexHtml, clientJs, worklets })),
  ).pipe(Effect.provide(Layer.mergeAll(sessionLayer, webSearchLayer(flags.search))))
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
