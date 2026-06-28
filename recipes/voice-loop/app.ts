/**
 * Runtime-agnostic composition of the voice-loop recipe.
 *
 * Everything that doesn't depend on Bun / Node / Deno lives here:
 *   - provider selection from argv (`--provider elevenlabs|mistral`)
 *   - provider service layers (STT + LLM + TTS) and their WebSocket
 *     constructor; the HTTP client comes from each runner's platform layer
 *   - HTTP routes (`/`, `/client.js`, `/config`, the two AudioWorklets,
 *     `/ws`) and the bidirectional WebSocket handler
 *   - the bootstrap `main` effect: bundle the browser client, read the
 *     static assets, launch the HTTP router
 *   - logger + log-level layer
 *
 * Each runner (`run-bun.ts`, `run-node.ts`, `run-deno.ts`) provides only the
 * platform pieces (`HttpServer`, `FileSystem`, `Path`, `HttpClient`) and calls
 * the matching `XxxRuntime.runMain`.
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
import * as Socket from "effect/unstable/socket/Socket"
import { layer as elevenlabsSynthesizer } from "@effect-uai/elevenlabs/ElevenLabsSynthesizer"
import { layer as elevenlabsTranscriber } from "@effect-uai/elevenlabs/ElevenLabsTranscriber"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { layer as mistralLayer } from "@effect-uai/mistral/Mistral"
import { layer as mistralRealtimeTranscriber } from "@effect-uai/mistral/MistralRealtimeTranscriber"
import { layer as mistralSynthesizer } from "@effect-uai/mistral/MistralSynthesizer"
import type { AudioFormat } from "@effect-uai/core/Audio"
import { providerFlag } from "../_shared/argv.js"
import { bundleClient } from "../_shared/bundle.js"
import { type PipelineConfig, runPipeline, type StatusEvent } from "./recipe.js"

// ---------------------------------------------------------------------------
// Config presets — one PipelineConfig per provider stack. These pick concrete
// models / voices / formats; the recipe body in recipe.ts is config-agnostic.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  // Always write the brand name as `effect-uai`. A server-side phonetic
  // rewrite (`effect-uai` -> `effect why`) handles pronunciation before
  // text hits the TTS engine, so the UI still shows the proper name.
  "You are a conversational voice assistant. Speak naturally and directly.",
  "You're happy to discuss any topic: explain things, brainstorm, banter",
  "lightly when it fits. Don't be performative, theatrical, or overly",
  'enthusiastic; no exclamations like "Oh!" or "Alright!". Just answer.',
  "",
  "The user is a single person continuing one conversation. Don't role-play",
  "or adopt personas based on how they phrase things: if they say",
  '"this is the manager," they\'re just talking, not introducing a character.',
  "",
  "Background (only if asked who or what you are):",
  "- You're powered by effect-uai, a TypeScript library built on Effect for",
  "  writing AI applications by composing small primitives instead of",
  "  configuring a framework.",
  "",
  "Voice-output rules:",
  "- One or two short sentences per turn. No lists, code, or markdown.",
  "- Always write the brand name as `effect-uai` (with the hyphen).",
  "- Never refuse a question as off-topic. If you don't know, say so briefly",
  "  and offer what you do know.",
].join("\n")

const elevenlabsConfig: PipelineConfig = {
  stt: {
    model: "scribe_v2_realtime",
    inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  },
  llm: { model: "gemini-2.5-flash", systemPrompt: SYSTEM_PROMPT },
  tts: {
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 48000, channels: 1 },
  },
  utteranceSettle: "350 millis",
}

// Voxtral realtime ingests pcm_s16le @ 16000 (same mic format). Voxtral TTS
// `pcm` is float32 LE @ 24000; `toPlaybackS16le` converts it for the worklet.
const mistralConfig: PipelineConfig = {
  stt: {
    model: "voxtral-mini-transcribe-realtime-2602",
    inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  },
  llm: { model: "mistral-small-latest", systemPrompt: SYSTEM_PROMPT },
  tts: {
    model: "voxtral-mini-tts-2603",
    // Voxtral preset voice id (others: us_paul_neutral, us_oliver_neutral, …).
    // List your account's presets via GET /v1/audio/voices?type=presets.
    voiceId: "gb_jane_neutral",
    outputFormat: { container: "raw", encoding: "pcm_f32le", sampleRate: 24000, channels: 1 },
  },
  utteranceSettle: "350 millis",
}

const configFor = (provider: Provider): PipelineConfig =>
  provider === "mistral" ? mistralConfig : elevenlabsConfig

// ---------------------------------------------------------------------------
// Audio glue — the browser playback worklet plays raw s16le PCM. Voxtral TTS
// emits float32 LE, so the server converts f32le chunks before sending them;
// s16le chunks pass through. Sample count (and thus duration) is unchanged.
// ---------------------------------------------------------------------------

const f32leToS16le = (bytes: Uint8Array): Uint8Array => {
  const sampleCount = Math.floor(bytes.byteLength / 4)
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, sampleCount)
  const out = new Int16Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    const clamped = Math.max(-1, Math.min(1, floats[i] ?? 0))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return new Uint8Array(out.buffer)
}

const toPlaybackS16le = (format: AudioFormat, bytes: Uint8Array): Uint8Array =>
  format.encoding === "pcm_f32le" ? f32leToS16le(bytes) : bytes

// ---------------------------------------------------------------------------
// Provider selection. `--provider elevenlabs|mistral` (default elevenlabs).
// Both stacks register the generic `Transcriber` / `LanguageModel` /
// `SpeechSynthesizer` tags plus the streaming capability markers, so the
// pipeline body in recipe.ts doesn't change.
// ---------------------------------------------------------------------------

type Provider = "elevenlabs" | "mistral"

const decodeProvider = (raw: string): Provider => {
  const v = raw.toLowerCase()
  if (v === "mistral" || v === "voxtral") return "mistral"
  if (v === "elevenlabs" || v === "eleven") return "elevenlabs"
  throw new Error(`unknown provider: ${raw} (expected: elevenlabs | mistral)`)
}

export const provider: Provider = Option.getOrElse(
  providerFlag(decodeProvider),
  (): Provider => "elevenlabs",
)

const layerFor = Match.type<Provider>().pipe(
  Match.when("elevenlabs", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const elevenKey = yield* Config.redacted("ELEVENLABS_API_KEY")
        const googleKey = yield* Config.redacted("GOOGLE_API_KEY")
        return Layer.mergeAll(
          elevenlabsTranscriber({ apiKey: elevenKey }),
          elevenlabsSynthesizer({ apiKey: elevenKey }),
          geminiLayer({ apiKey: googleKey }),
        )
      }),
    ),
  ),
  Match.when("mistral", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("MISTRAL_API_KEY")
        return Layer.mergeAll(
          mistralRealtimeTranscriber({ apiKey }),
          mistralSynthesizer({ apiKey }),
          mistralLayer({ apiKey }),
        )
      }),
    ),
  ),
  Match.exhaustive,
)

// ---------------------------------------------------------------------------
// WebSocket handler.
//
// Bridges the callback-shaped `runPipeline` onto the upgrade Channel: outbound
// status (text frames) and TTS audio (binary frames) drain from `outQueue`;
// inbound mic bytes feed `micQueue`. The pipeline runs fork-scoped to the
// connection.
// ---------------------------------------------------------------------------

const wsHandler = (cfg: PipelineConfig, minLevel: "Info" | "Debug") =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[ws] browser connected")

    const micQueue = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>()
    const outQueue = yield* Queue.unbounded<string | Uint8Array, Cause.Done<void>>()

    const sendStatus = (event: StatusEvent): Effect.Effect<void> =>
      Effect.asVoid(Queue.offer(outQueue, JSON.stringify(event)))
    const sendAudio = (bytes: Uint8Array): Effect.Effect<void> =>
      Effect.asVoid(Queue.offer(outQueue, toPlaybackS16le(cfg.tts.outputFormat, bytes)))

    yield* runPipeline(cfg, Stream.fromQueue(micQueue), sendStatus, sendAudio).pipe(
      Effect.scoped,
      Effect.provideService(References.MinimumLogLevel, minLevel),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[pipeline] connection teardown")
          : Effect.logError("[pipeline] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(Queue.end(outQueue)),
      Effect.forkScoped,
    )

    yield* Stream.toChannel(Stream.fromQueue(outQueue)).pipe(
      Channel.pipeTo(HttpServerRequest.upgradeChannel<never>()),
      Stream.fromChannel,
      Stream.runForEach((buf) => Queue.offer(micQueue, buf)),
      Effect.catchTag("SocketError", () => Effect.logInfo("[ws] browser disconnected")),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[ws] browser disconnected")
          : Effect.logError("[ws] failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(Queue.end(micQueue)),
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
  readonly cfg: PipelineConfig
  readonly indexHtml: string
  readonly clientJs: string
  readonly micWorkletJs: string
  readonly playbackWorkletJs: string
  readonly minLevel: "Info" | "Debug"
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
          micSampleRate: assets.cfg.stt.inputFormat.sampleRate,
          playbackSampleRate: assets.cfg.tts.outputFormat.sampleRate,
        }),
        { contentType: "application/json; charset=utf-8" },
      ),
    ),
    HttpRouter.add("GET", "/ws", wsHandler(assets.cfg, assets.minLevel)),
  )

// ---------------------------------------------------------------------------
// Bootstrap effect.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const cfg = configFor(provider)
  const minLevel =
    (yield* Config.string("PIPELINE_DEBUG").pipe(Config.withDefault("0"))) === "1"
      ? "Debug"
      : "Info"

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  // All client code is TypeScript, bundled on demand (no prebuilt JS on disk).
  // The two AudioWorklets are bundled as their own entry points since they load
  // into a separate `AudioWorkletGlobalScope` via `audioWorklet.addModule`.
  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const micWorkletJs = yield* bundleClient(path.join(recipeDir, "client/mic-worklet.ts"))
  const playbackWorkletJs = yield* bundleClient(path.join(recipeDir, "client/playback-worklet.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "client/index.html"))

  yield* Effect.logInfo(
    `voice-loop (${provider}: stt=${cfg.stt.model} llm=${cfg.llm.model} tts=${cfg.tts.model})`,
  )

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break the runners' types, so keep returning
  // the launch effect here.
  // @effect-diagnostics-next-line effect/returnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(
      routesLayer({ cfg, indexHtml, clientJs, micWorkletJs, playbackWorkletJs, minLevel }),
    ),
  )
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)

// ---------------------------------------------------------------------------
// App-level layer: everything that's NOT platform-specific. Runners merge
// this with their platform layers (`HttpServer`, `FileSystem`, `Path`,
// `HttpClient`) and call `XxxRuntime.runMain`.
// ---------------------------------------------------------------------------

export const appLayer = Layer.mergeAll(
  layerFor(provider).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  Logger.layer([Logger.consolePretty()]),
)
