/**
 * Bun runner for the streaming-synthesis recipe. Serves the static
 * frontend, bundles `client/main.ts` at startup, and upgrades `/ws`
 * connections to a duplex pipe:
 *
 *   browser text  →  Stream<string>  →  streamSynthesisFrom  →  audio chunks  →  browser
 *
 * The queue stays open across submissions: each Enter from the browser
 * adds another sentence to the same upstream TTS session.
 *
 *   ELEVENLABS_API_KEY=... bun recipes/streaming-synthesis/run-bun.ts
 */
import * as path from "node:path"
import { Cause, Config, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { layer as elevenlabsLayer } from "@effect-uai/elevenlabs/ElevenLabsSynthesizer"
import { synthesizeText } from "./index.js"

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const appLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY")
    return elevenlabsLayer({ apiKey })
  }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Socket.layerWebSocketConstructorGlobal))

const runtime = ManagedRuntime.make(appLayer)

// ---------------------------------------------------------------------------
// Per-connection pipeline: Stream<string> → audio chunks → ws.send (binary)
// ---------------------------------------------------------------------------

type TextQueue = Queue.Queue<string, Cause.Done<void>>

const pipeline = (queue: TextQueue, sendBinary: (bytes: Uint8Array) => void) =>
  Stream.fromQueue(queue).pipe(
    synthesizeText,
    Stream.runForEach((chunk) => Effect.sync(() => sendBinary(chunk.bytes))),
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.sync(() => console.error("[pipeline]", Cause.pretty(cause))),
    ),
  )

// ---------------------------------------------------------------------------
// Bundle the client
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
const playbackWorkletJs = await Bun.file(path.join(recipeDir, "public/playback-worklet.js")).text()

// ---------------------------------------------------------------------------
// Bun.serve
// ---------------------------------------------------------------------------

type WsData = { readonly queue?: TextQueue }

const port = Number(process.env["PORT"] ?? 3000)

const responseOf = (body: string, type: string): Response =>
  new Response(body, { headers: { "content-type": type } })

const TERMINATORS = /[.!?]\s*$/

// Push each submission as a single frame so ElevenLabs sees one
// generation unit — smoother prosody, no per-word audio seams.
// Terminator nudges the model to flush promptly.
const offerSubmission = (queue: TextQueue, text: string): void => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  Queue.offerUnsafe(queue, TERMINATORS.test(trimmed) ? `${trimmed} ` : `${trimmed}. `)
}

const parseTextFrame = (msg: unknown): string | undefined => {
  if (typeof msg !== "string") return undefined
  try {
    const { text } = JSON.parse(msg) as { text?: unknown }
    return typeof text === "string" ? text : undefined
  } catch {
    return undefined
  }
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
        readonly send: (msg: Uint8Array) => number
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
    "/playback-worklet.js": responseOf(playbackWorkletJs, "application/javascript; charset=utf-8"),
    "/ws": (req, server) => {
      const queue = Effect.runSync(Queue.unbounded<string, Cause.Done<void>>())
      const upgraded = server.upgrade(req, { data: { queue } })
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 })
    },
  },
  websocket: {
    open(ws) {
      if (!ws.data.queue) return
      runtime.runFork(
        pipeline(ws.data.queue, (bytes) => {
          ws.send(bytes)
        }).pipe(Effect.ensuring(Effect.sync(() => ws.close()))),
      )
    },
    message(ws, msg) {
      if (!ws.data.queue) return
      const text = parseTextFrame(msg)
      if (text !== undefined && text.length > 0) offerSubmission(ws.data.queue, text)
    },
    close(ws) {
      if (ws.data.queue !== undefined) Queue.endUnsafe(ws.data.queue)
    },
  },
})

console.log(`streaming-synthesis recipe → http://localhost:${port}`)
