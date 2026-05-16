/**
 * Bun runner for the voice-loop recipe.
 *
 *   ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... \
 *     bun recipes/voice-loop/run-bun.ts
 *
 * Wire format on the browser ↔ server WebSocket:
 *   browser → server : binary frames = PCM s16le 16 kHz mono mic audio
 *   server  → browser:
 *     - binary frames    = PCM s16le 48 kHz mono TTS audio for playback
 *     - text JSON frames = `StatusEvent` (user / assistant transcript states)
 */
import * as path from "node:path"
import {
  Cause,
  Config,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Queue,
  References,
  Stream,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { layer as elevenlabsSynthesizer } from "@effect-uai/elevenlabs/ElevenLabsSynthesizer"
import { layer as elevenlabsTranscriber } from "@effect-uai/elevenlabs/ElevenLabsTranscriber"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { defaultConfig, runPipeline, type StatusEvent } from "./index.js"

// ---------------------------------------------------------------------------
// App runtime — single ManagedRuntime reused across all WS connections.
// ---------------------------------------------------------------------------

const providerLayers = Layer.unwrap(
  Effect.gen(function* () {
    const elevenKey = yield* Config.redacted("ELEVENLABS_API_KEY")
    const googleKey = yield* Config.redacted("GOOGLE_API_KEY")
    return Layer.mergeAll(
      elevenlabsTranscriber({ apiKey: elevenKey }),
      elevenlabsSynthesizer({ apiKey: elevenKey }),
      geminiLayer({ apiKey: googleKey }),
    )
  }),
)

const appLayer = Layer.mergeAll(
  providerLayers.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  ),
  Logger.layer([Logger.consolePretty()]),
)

const runtime = ManagedRuntime.make(appLayer)

// Log level: Info by default, Debug if PIPELINE_DEBUG=1 (surfaces every
// partial transcript event — noisy but useful when chasing wire issues).
const minLevel = process.env["PIPELINE_DEBUG"] === "1" ? "Debug" : "Info"

// ---------------------------------------------------------------------------
// Per-connection pipeline — wire mic queue into runPipeline and route the
// pipeline's status / audio outputs back to the browser WS.
// ---------------------------------------------------------------------------

type AudioQueue = Queue.Queue<Uint8Array, Cause.Done<void>>

const pipelineFor = (
  queue: AudioQueue,
  sendText: (json: string) => void,
  sendBinary: (bytes: Uint8Array) => void,
) =>
  runPipeline(
    defaultConfig,
    Stream.fromQueue(queue),
    (event: StatusEvent) => Effect.sync(() => sendText(JSON.stringify(event))),
    (bytes) => Effect.sync(() => sendBinary(bytes)),
  ).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, minLevel),
    Effect.tapCause((cause) =>
      // Clean teardown (browser disconnect / upstream WS close) shows up
      // as an Interrupt — only surface real failure causes.
      Cause.hasInterruptsOnly(cause)
        ? Effect.logInfo("[pipeline] connection teardown")
        : Effect.logError("[pipeline] failed", { cause: Cause.pretty(cause) }),
    ),
  )

// ---------------------------------------------------------------------------
// Bundle the client TS + serve static assets.
// ---------------------------------------------------------------------------

const recipeDir = path.dirname(new URL(import.meta.url).pathname)

const built = await Bun.build({
  entrypoints: [path.join(recipeDir, "client/main.ts")],
  target: "browser",
  format: "esm",
})
if (!built.success) {
  console.error("client bundle failed:", built.logs)
  process.exit(1)
}
const clientJs = await built.outputs[0]!.text()
const indexHtml = await Bun.file(path.join(recipeDir, "public/index.html")).text()
const micWorkletJs = await Bun.file(path.join(recipeDir, "public/mic-worklet.js")).text()
const playbackWorkletJs = await Bun.file(path.join(recipeDir, "public/playback-worklet.js")).text()

const configJson = JSON.stringify({
  micSampleRate: defaultConfig.stt.inputFormat.sampleRate,
  playbackSampleRate: defaultConfig.tts.outputFormat.sampleRate,
})

// ---------------------------------------------------------------------------
// Bun.serve
// ---------------------------------------------------------------------------

type WsData = { readonly queue?: AudioQueue }

const port = Number(process.env["PORT"] ?? 3000)

const responseOf = (body: string, type: string): Response =>
  new Response(body, { headers: { "content-type": type } })

const bytesOf = (msg: string | Buffer | Uint8Array | ArrayBuffer): Uint8Array | undefined => {
  if (typeof msg === "string") return undefined
  if (msg instanceof Uint8Array) return msg
  return new Uint8Array(msg)
}

declare const Bun: {
  readonly build: (config: {
    readonly entrypoints: ReadonlyArray<string>
    readonly target: "browser"
    readonly format: "esm"
  }) => Promise<{
    readonly success: boolean
    readonly logs: ReadonlyArray<unknown>
    readonly outputs: ReadonlyArray<{ readonly text: () => Promise<string> }>
  }>
  readonly file: (p: string) => { readonly text: () => Promise<string> }
  readonly serve: <D>(config: {
    readonly port: number
    readonly routes: Record<
      string,
      | Response
      | ((
          req: Request,
          server: { readonly upgrade: (req: Request, opts?: { data: D }) => boolean },
        ) => Response | undefined)
    >
    readonly websocket: {
      readonly open: (ws: {
        readonly data: D
        readonly send: (msg: string | Uint8Array) => number
        readonly close: () => void
      }) => void
      readonly message: (
        ws: { readonly data: D },
        msg: string | Buffer | Uint8Array | ArrayBuffer,
      ) => void
      readonly close: (ws: { readonly data: D }) => void
    }
  }) => unknown
}

Bun.serve<WsData>({
  port,
  routes: {
    "/": responseOf(indexHtml, "text/html; charset=utf-8"),
    "/client.js": responseOf(clientJs, "application/javascript; charset=utf-8"),
    "/mic-worklet.js": responseOf(micWorkletJs, "application/javascript; charset=utf-8"),
    "/playback-worklet.js": responseOf(playbackWorkletJs, "application/javascript; charset=utf-8"),
    "/config": responseOf(configJson, "application/json; charset=utf-8"),
    "/ws": (req, server) => {
      const queue = Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done<void>>())
      const upgraded = server.upgrade(req, { data: { queue } })
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 })
    },
  },
  websocket: {
    open(ws) {
      if (!ws.data.queue) return
      console.log("[ws] browser connected")
      runtime.runFork(
        pipelineFor(
          ws.data.queue,
          (json) => {
            ws.send(json)
          },
          (bytes) => {
            ws.send(bytes)
          },
        ).pipe(Effect.ensuring(Effect.sync(() => ws.close()))),
      )
    },
    message(ws, msg) {
      const bytes = bytesOf(msg)
      if (bytes !== undefined && ws.data.queue !== undefined) {
        Queue.offerUnsafe(ws.data.queue, bytes)
      }
    },
    close(ws) {
      console.log("[ws] browser disconnected")
      if (ws.data.queue !== undefined) Queue.endUnsafe(ws.data.queue)
    },
  },
})

console.log(`voice-loop (elevenlabs STT/TTS + gemini-2.5-flash) → http://localhost:${port}`)
console.log(`log level: ${minLevel} (set PIPELINE_DEBUG=1 for verbose STT partials)`)
