/**
 * Runtime-agnostic composition of the voice-loop recipe.
 *
 * `--provider elevenlabs|mistral` picks a whole stack, not one model: each
 * preset below fixes the STT, LLM and TTS models together with the voice and
 * the audio formats they agree on, which is why this recipe takes a provider
 * rather than three separate `--model` flags. `--debug` turns on the
 * per-frame pipeline log.
 *
 * Also here: the HTTP routes (`/`, `/client.js`, `/ws`), the live session on
 * `/ws`, and the bootstrap `main`, which bundles the browser client and
 * launches the router. `run.ts` supplies the platform `HttpServer`,
 * `FileSystem`, `Path`, `HttpClient` and the WebSocket constructor.
 */
import {
  type Cause,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  References,
  Stdio,
  Stream,
} from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Frame from "@effect-uai/ui/Frame"
import * as LiveSocket from "@effect-uai/ui/LiveSocket"
import type * as Run from "@effect-uai/ui/Run"
import { StreamId } from "@effect-uai/ui/RunEvent"
import { flagValue, providerChoice } from "@effect-uai/recipe-kit/argv"
import {
  incrementalSynthesizerLayer,
  languageModelLayer,
  streamingTranscriberLayer,
} from "../_shared/model.js"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { MIC, Up } from "./contract.js"
import { type PipelineConfig, runPipeline } from "./recipe.js"

// ---------------------------------------------------------------------------
// Config presets: one PipelineConfig per provider stack. These pick concrete
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
// `pcm` is float32 LE @ 24000; the recipe converts it to 16-bit for the browser.
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
// Provider selection. `--provider elevenlabs|mistral` (default elevenlabs).
// Both stacks register the generic `Transcriber` / `LanguageModel` /
// `SpeechSynthesizer` tags plus the streaming capability markers, so the
// pipeline body in recipe.ts doesn't change.
// ---------------------------------------------------------------------------

type Provider = "elevenlabs" | "mistral"

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    provider: yield* providerChoice("elevenlabs", "mistral"),
    debug: Option.isSome(flagValue("debug", argv)),
  }
})

/**
 * The three capabilities the pipeline needs, resolved from the preset's own
 * model ids. ElevenLabs has no language model, so that stack borrows Gemini.
 */
const layersFor = (provider: Provider, cfg: PipelineConfig) =>
  provider === "mistral"
    ? Layer.mergeAll(
        streamingTranscriberLayer({ provider: "mistral", model: cfg.stt.model }),
        incrementalSynthesizerLayer({ provider: "mistral", model: cfg.tts.model }),
        languageModelLayer({ provider: "mistral", model: cfg.llm.model }),
      )
    : Layer.mergeAll(
        streamingTranscriberLayer({ provider: "elevenlabs", model: cfg.stt.model }),
        incrementalSynthesizerLayer({ provider: "elevenlabs", model: cfg.tts.model }),
        languageModelLayer({ provider: "google", model: cfg.llm.model }),
      )

// ---------------------------------------------------------------------------
// The live session. `runPipeline` emits frames through a callback; the
// handler turns that into the session's stream, and the mic channel's
// frames into the pipeline's audio. A pipeline failure ends the session with
// a `problem`.
// ---------------------------------------------------------------------------

const session = (cfg: PipelineConfig, minLevel: "Info" | "Debug") =>
  LiveSocket.handle({
    up: Up,
    handler: (up) => {
      const mic = up.pipe(
        Stream.filter(
          (frame): frame is Frame.Media => frame._tag === "Media" && frame.channel === MIC,
        ),
        Stream.map((frame) => frame.bytes),
      )
      return Stream.callback((queue: Queue.Queue<Frame.Frame<Run.Owned>, Cause.Done>) =>
        runPipeline(cfg, mic, (frame) => Effect.asVoid(Queue.offer(queue, frame))).pipe(
          Effect.catch((error) =>
            Queue.offer(
              queue,
              Frame.message({ event: { type: "live", name: "problem", value: error._tag } }),
            ),
          ),
          Effect.provideService(References.MinimumLogLevel, minLevel),
          Effect.ensuring(Queue.end(queue)),
        ),
      ).pipe(Frame.sequence(StreamId.make("voice")))
    },
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
  readonly minLevel: "Info" | "Debug"
}

const routesLayer = (assets: Assets) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/", HttpServerResponse.html(assets.indexHtml)),
    HttpRouter.add("GET", "/client.js", js(assets.clientJs)),
    HttpRouter.add("GET", "/ws", session(assets.cfg, assets.minLevel)),
  )

// ---------------------------------------------------------------------------
// Bootstrap effect.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const flags = yield* readFlags
  const cfg = configFor(flags.provider)
  const minLevel = flags.debug ? "Debug" : "Info"

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  // The client is TypeScript, bundled on demand (no prebuilt JS on disk).
  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "client/index.html"))

  yield* Effect.logInfo(
    `voice-loop (${flags.provider}: stt=${cfg.stt.model} llm=${cfg.llm.model} tts=${cfg.tts.model})`,
  )

  // The rule's `return yield*` suggestion would surface the served layer's
  // requirements onto main's R and break `run.ts`, so keep returning the
  // launch effect here.
  // @effect-diagnostics-next-linereturnEffectInGen:off
  return Layer.launch(HttpRouter.serve(routesLayer({ cfg, indexHtml, clientJs, minLevel }))).pipe(
    Effect.provide(layersFor(flags.provider, cfg)),
  )
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
