/**
 * Bun runner for the streaming-transcription recipe. Serves the static
 * frontend, bundles `client/main.ts` at startup, and upgrades `/ws`
 * connections to bidi WebSockets backed by an Effect pipeline:
 * inbound mic frames → `Transcriber.streamTranscriptionFrom` → JSON
 * TranscriptEvents back over the same socket.
 *
 *   ELEVENLABS_API_KEY=... bun recipes/streaming-transcription/run-bun.ts
 */
import * as path from "node:path"
import { Cause, Config, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { layer as elevenlabsLayer } from "@effect-uai/elevenlabs/ElevenLabsTranscriber"
import { transcribeMicStream } from "./index.js"

// ---------------------------------------------------------------------------
// App runtime — Layer is built once and reused across all WS connections.
// ---------------------------------------------------------------------------

const appLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY")
    return elevenlabsLayer({ apiKey })
  }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Socket.layerWebSocketConstructorGlobal))

const runtime = ManagedRuntime.make(appLayer)

// ---------------------------------------------------------------------------
// Per-connection pipeline
// ---------------------------------------------------------------------------

type AudioQueue = Queue.Queue<Uint8Array, Cause.Done<void>>

const pipeline = (queue: AudioQueue, send: (json: string) => void) =>
  Stream.fromQueue(queue).pipe(
    transcribeMicStream,
    Stream.runForEach((event) => Effect.sync(() => send(JSON.stringify(event)))),
    Effect.tapCause((cause) =>
      // Clean teardown (browser disconnect, upstream WS close) shows up as
      // an Interrupt — only surface real failure causes.
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.sync(() => console.error("[pipeline]", Cause.pretty(cause))),
    ),
  )

// ---------------------------------------------------------------------------
// Bundle the client TS at startup. Bun handles `effect` imports too.
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
const audioWorkletJs = await Bun.file(path.join(recipeDir, "public/audio-worklet.js")).text()

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
        readonly send: (msg: string) => number
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
    "/audio-worklet.js": responseOf(audioWorkletJs, "application/javascript; charset=utf-8"),
    "/ws": (req, server) => {
      const queue = Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done<void>>())
      const upgraded = server.upgrade(req, { data: { queue } })
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 })
    },
  },
  websocket: {
    open(ws) {
      if (!ws.data.queue) return
      runtime.runFork(
        pipeline(ws.data.queue, (json) => {
          ws.send(json)
        }).pipe(Effect.ensuring(Effect.sync(() => ws.close()))),
      )
    },
    message(ws, msg) {
      const bytes = bytesOf(msg)
      if (bytes !== undefined && ws.data.queue !== undefined) {
        Queue.offerUnsafe(ws.data.queue, bytes)
      }
    },
    close(ws) {
      if (ws.data.queue !== undefined) Queue.endUnsafe(ws.data.queue)
    },
  },
})

console.log(`streaming-transcription recipe → http://localhost:${port}`)
