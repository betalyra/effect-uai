/**
 * Bun runner for the radio-station recipe.
 *
 *   OPENAI_API_KEY=... ELEVENLABS_API_KEY=... \
 *     bun recipes/radio-station/run-bun.ts
 *
 *   # Switch provider via argv (matches basic-music-generation):
 *   GOOGLE_API_KEY=... bun recipes/radio-station/run-bun.ts --provider=google
 *
 *   # Optional: custom station brief
 *   STATION_BRIEF="synthwave roadtrip, neon and fast" bun ...
 *
 * Wire format on the browser ↔ server WebSocket:
 *   server  → browser:
 *     - binary frames    = MP3 chunks (one continuous audio stream;
 *                          MediaSource appends them into a single
 *                          SourceBuffer that plays seamlessly).
 *     - text JSON frames = `ServerEvent` (`station-planned`,
 *                          `track-start`, `track-end`).
 *   browser → server:
 *     - text JSON frames = `ClientEvent` (`track-ended` after each
 *                          track's audio ends — used to backpressure
 *                          generation against actual listening time).
 */
import * as path from "node:path"
import { mkdir, rename, unlink } from "node:fs/promises"
import {
  Cause,
  Config,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Match,
  Queue,
  References,
  Stream,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import { layer as elevenlabsMusicLayer } from "@effect-uai/elevenlabs/ElevenLabsMusicGenerator"
import { layer as lyriaLayer } from "@effect-uai/google/LyriaGenerator"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { runStation, type FileSystemHooks, type ServerEvent } from "./index.js"

// ---------------------------------------------------------------------------
// Provider selection — `--provider=google|elevenlabs` (default elevenlabs).
// Both register the generic `MusicGenerator` service tag, so the recipe
// body in index.ts doesn't change. Mirrors the argv style used in
// recipes/basic-music-generation/run-node.ts.
// ---------------------------------------------------------------------------

type Provider = "elevenlabs" | "google"

const normalizeProvider = (raw: string): Provider => {
  const v = raw.toLowerCase()
  if (v === "google" || v === "lyria") return "google"
  if (v === "elevenlabs" || v === "eleven") return "elevenlabs"
  throw new Error(`unknown provider: ${raw} (expected: elevenlabs | google)`)
}

const providerFromArgv = (argv: ReadonlyArray<string>): Provider | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--provider=")) return normalizeProvider(a.slice("--provider=".length))
    if (a === "--provider") {
      const next = argv[i + 1]
      if (next === undefined) throw new Error("--provider requires a value")
      return normalizeProvider(next)
    }
  }
  return undefined
}

const provider: Provider = providerFromArgv(process.argv.slice(2)) ?? "elevenlabs"

const defaults = {
  elevenlabs: { model: "music_v1", keyEnv: "ELEVENLABS_API_KEY" },
  google: { model: "lyria-3-clip-preview", keyEnv: "GOOGLE_API_KEY" },
} as const

// ---------------------------------------------------------------------------
// App runtime — single ManagedRuntime reused across all WS connections.
// ---------------------------------------------------------------------------

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

const providerLayers = Layer.mergeAll(
  musicLayerFor(provider),
  Layer.unwrap(
    Effect.gen(function* () {
      const openaiKey = yield* Config.redacted("OPENAI_API_KEY")
      return responsesLayer({ apiKey: openaiKey })
    }),
  ),
)

const appLayer = Layer.mergeAll(
  providerLayers.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

const runtime = ManagedRuntime.make(appLayer)

const minLevel = process.env["PIPELINE_DEBUG"] === "1" ? "Debug" : "Info"

// ---------------------------------------------------------------------------
// Tracks directory — disk cache for generated MP3s. Per-provider subdir
// so switching providers doesn't replay one provider's tracks with the
// other's titles. Reusing across runs is free; delete the folder to
// force full regeneration.
// ---------------------------------------------------------------------------

const recipeDir = path.dirname(new URL(import.meta.url).pathname)
const tracksDir = path.join(recipeDir, "tracks", provider)
await mkdir(tracksDir, { recursive: true })

// ---------------------------------------------------------------------------
// Runtime-specific file ops, supplied to runStation via config. Swapping
// runtimes (a future run-node.ts, run-deno.ts, ...) means only this value
// changes — the recipe body is runtime-agnostic.
// ---------------------------------------------------------------------------

const bunFs: FileSystemHooks = {
  exists: (filePath) => Effect.promise(() => Bun.file(filePath).exists()),
  readStream: (filePath) =>
    Stream.fromReadableStream({
      evaluate: () => Bun.file(filePath).stream(),
      onError: (e) => new AiError.Unavailable({ provider: "disk-cache", raw: e }),
    }),
  openWriter: (filePath) =>
    Effect.sync(() => {
      const w = Bun.file(filePath).writer()
      return {
        write: (chunk) => {
          w.write(chunk)
        },
        // Bun's FileSink.end() is documented as Promise<number> but
        // returns synchronously in 1.3.x — wrap in an async fn so the
        // result is always a thenable Effect.promise can resolve.
        end: Effect.promise(async () => {
          await w.end()
        }),
      }
    }),
  rename: (from, to) => Effect.promise(() => rename(from, to)),
  unlink: (filePath) => Effect.promise(() => unlink(filePath)).pipe(Effect.ignore),
}

// ---------------------------------------------------------------------------
// Per-connection pipeline
// ---------------------------------------------------------------------------

type AckQueue = Queue.Queue<void, Cause.Done<void>>

const pipelineFor = (
  ackQueue: AckQueue,
  sendText: (json: string) => void,
  sendBinary: (bytes: Uint8Array) => void,
) =>
  runStation({
    brief:
      process.env["STATION_BRIEF"] ?? "late-night lo-fi study session, mellow and instrumental",
    trackCount: Number(process.env["TRACK_COUNT"] ?? 10),
    plannerModel: process.env["PLANNER_MODEL"] ?? "gpt-5.4-mini",
    musicModel: process.env["MUSIC_MODEL"] ?? defaults[provider].model,
    tracksDir,
    fs: bunFs,
    send: (event: ServerEvent) => Effect.sync(() => sendText(JSON.stringify(event))),
    sendBytes: (bytes) => Effect.sync(() => sendBinary(bytes)),
    // Queue.take fails with `Done` when the queue is ended (WS close);
    // convert that to a self-interrupt so the whole pipeline tears down
    // cleanly instead of surfacing as a pipeline error.
    waitTrackEnded: Queue.take(ackQueue).pipe(Effect.catch(() => Effect.interrupt)),
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, minLevel),
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.logInfo("[pipeline] connection teardown")
        : Effect.logError("[pipeline] failed", { cause: Cause.pretty(cause) }),
    ),
  )

// ---------------------------------------------------------------------------
// Bundle the client TS + serve static assets
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Bun.serve
// ---------------------------------------------------------------------------

type WsData = { readonly ack?: AckQueue }

const port = Number(process.env["PORT"] ?? 3000)

const responseOf = (body: string, type: string): Response =>
  new Response(body, { headers: { "content-type": type } })

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
  readonly file: (p: string) => {
    readonly text: () => Promise<string>
    readonly exists: () => Promise<boolean>
    readonly stream: () => ReadableStream<Uint8Array>
    readonly writer: () => {
      readonly write: (chunk: Uint8Array) => number
      readonly end: () => number | Promise<number>
    }
  }
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
    "/ws": (req, server) => {
      const ack = Effect.runSync(Queue.unbounded<void, Cause.Done<void>>())
      const upgraded = server.upgrade(req, { data: { ack } })
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 })
    },
  },
  websocket: {
    open(ws) {
      if (!ws.data.ack) return
      console.log("[ws] browser connected")
      runtime.runFork(
        pipelineFor(
          ws.data.ack,
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
      if (typeof msg !== "string" || ws.data.ack === undefined) return
      // Single in-band signal: { type: "track-ended" }. Any other text
      // frame is ignored — keeps the wire honest.
      try {
        const event = JSON.parse(msg) as { type?: string }
        if (event.type === "track-ended") Queue.offerUnsafe(ws.data.ack, undefined)
      } catch {
        // ignore malformed frames
      }
    },
    close(ws) {
      console.log("[ws] browser disconnected")
      if (ws.data.ack !== undefined) Queue.endUnsafe(ws.data.ack)
    },
  },
})

console.log(
  `radio-station (responses + ${provider} music: ${defaults[provider].model}) → http://localhost:${port}`,
)
console.log(`tracks cached at: ${tracksDir}`)
console.log(`log level: ${minLevel}`)
