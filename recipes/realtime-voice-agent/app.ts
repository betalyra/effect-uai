/**
 * Composition for the realtime-voice-agent recipe: the demo tools, the
 * provider preset, the HTTP routes and the WebSocket bridge.
 *
 * `--provider openai` or `--provider google`. A realtime provider is one
 * socket rather than three services, so the preset fixes the model, the voice
 * and the audio formats together; `recipe.ts` never sees which provider it is
 * talking to. `run.ts` supplies the platform `HttpServer`, `FileSystem` and
 * `Path`.
 */
import {
  Cause,
  Channel,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Match,
  Path,
  Queue,
  Schema,
  Stdio,
  Stream,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { webSearchTool } from "@effect-uai/core/WebSearchTool"
import { flagValue, providerChoice } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import { realtimeSessionLayer, webSearchLayer } from "../_shared/model.js"
import { type AgentConfig, runAgent, type StatusEvent } from "./recipe.js"

// ---------------------------------------------------------------------------
// Tools. One answers from the clock at once; the other two go out to the
// network. The slow ones are the interesting ones, since they are where you
// hear the session stay alive while work happens beside it.
// ---------------------------------------------------------------------------

const invalidTimeZone = (timezone: string) => new Error(`Invalid IANA timezone: ${timezone}`)

const getCurrentTime = Tool.make({
  name: "get_current_time",
  description: "The current local time for an IANA timezone, e.g. 'Europe/Lisbon'.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ timezone: Schema.String })),
  run: ({ timezone }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        DateTime.setZoneNamed(now, timezone).pipe(
          Option.match({
            onNone: () => Effect.fail(invalidTimeZone(timezone)),
            onSome: (zoned) => Effect.succeed({ timezone, iso: DateTime.formatIsoZoned(zoned) }),
          }),
        ),
      ),
    ),
  strict: true,
})

// Open-Meteo needs no key, which is what makes it usable in a demo.
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search"
const FORECAST = "https://api.open-meteo.com/v1/forecast"

const Places = Schema.Struct({
  results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        country: Schema.optional(Schema.String),
        latitude: Schema.Number,
        longitude: Schema.Number,
      }),
    ),
  ),
})

const Current = Schema.Struct({
  current: Schema.Struct({
    temperature_2m: Schema.Number,
    weather_code: Schema.Number,
    wind_speed_10m: Schema.optional(Schema.Number),
  }),
})

const between = (low: number, high: number) => (code: number) => code >= low && code <= high

/** WMO weather codes, grouped down to what a person would say out loud. */
const skyOf = (code: number): string =>
  Match.value(code).pipe(
    Match.when(0, () => "clear"),
    Match.when(between(1, 3), () => "partly cloudy"),
    Match.when(between(45, 48), () => "foggy"),
    Match.when(between(51, 57), () => "drizzling"),
    Match.when(between(61, 67), () => "raining"),
    Match.when(between(71, 77), () => "snowing"),
    Match.when(between(80, 82), () => "showery"),
    Match.when(between(95, 99), () => "thundery"),
    Match.orElse(() => "unsettled"),
  )

const getJson = <A, I>(url: string, schema: Schema.Codec<A, I>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get(url))
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json)
  })

const getWeather = Tool.make({
  name: "get_weather",
  description: "The weather right now in a place, from Open-Meteo.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ city: Schema.String })),
  run: ({ city }) =>
    Effect.gen(function* () {
      // The model often says "Leiria, Portugal"; the geocoder wants the name.
      const name = city.split(",")[0]?.trim() ?? city
      const places = yield* getJson(
        `${GEOCODE}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
        Places,
      )
      const place = places.results?.[0]
      if (place === undefined) return `I could not find anywhere called ${city}.`
      const { current } = yield* getJson(
        `${FORECAST}?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code,wind_speed_10m`,
        Current,
      )
      return {
        place: [place.name, place.country].filter(Boolean).join(", "),
        celsius: Math.round(current.temperature_2m),
        sky: skyOf(current.weather_code),
        windKph:
          current.wind_speed_10m === undefined ? undefined : Math.round(current.wind_speed_10m),
      }
    }),
  strict: true,
})

// Few search results: each one is read aloud eventually, and a spoken answer
// has no room for ten.
const toolkit = Toolkit.make(getCurrentTime, getWeather, webSearchTool({ maxResults: 3 }))

// ---------------------------------------------------------------------------
// Provider presets.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  "You are Betty, a voice assistant built with effect-uai. Speak naturally and",
  "directly, one or two short sentences per turn. No lists, no markdown, no",
  "code. The name is spoken as 'effect why'.",
  "",
  "What effect-uai is: a TypeScript library built on Effect for writing AI",
  "applications by composing small primitives instead of configuring a",
  "framework. Every provider sits behind a shared capability tag, so swapping",
  "one is a Layer swap and the application code does not change.",
  "",
  "In effect-uai a recipe is a runnable example app, and you are running inside",
  "one called realtime-voice-agent. So when someone asks how the recipe, the",
  "demo, or you work, they mean this, never cooking.",
  "",
  "How it works: it streams end to end and your voice",
  "never leaves the audio domain. The browser captures microphone audio and",
  "streams it over one WebSocket to a small server, which forwards it frame by",
  "frame to a realtime speech-to-speech model and streams the reply audio",
  "straight back to the page. There is no transcription step and no separate",
  "text model in between. The model decides when a turn ended and when it was",
  "interrupted, and on an interruption the server tells it how much of the",
  "answer was actually heard, so the unheard part leaves the conversation.",
  "Tool calls run in their own fibers, so the conversation keeps flowing while",
  "a tool works.",
  "",
  "Your tools are get_current_time, get_weather, and web_search for anything",
  "you could not already know, such as news, prices or what happened today.",
  "Say a few words before you call one so the person is not left in silence,",
  "and answer from what you find in one or two sentences without reading out",
  "the links.",
  "",
  "Never refuse a question as off-topic. If you do not know, say so briefly.",
].join("\n")

type Provider = "openai" | "google"

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    provider: yield* providerChoice("openai", "google"),
    search: Option.getOrElse(flagValue("search", argv), () => "exa"),
  }
})

const pcm = (sampleRate: AgentConfig["inputFormat"]["sampleRate"]) =>
  ({ container: "raw", encoding: "pcm_s16le", sampleRate, channels: 1 }) as const

/**
 * Each provider fixes its own rates: Gemini listens at 16 kHz and speaks at
 * 24 kHz, OpenAI does both at 24. The client reads them from `/config`, so
 * the worklets resample to whatever this says.
 */
const configFor = (provider: Provider): AgentConfig =>
  Match.value(provider).pipe(
    Match.when("openai", () => ({
      model: "gpt-realtime-2.1",
      instructions: INSTRUCTIONS,
      voiceId: "marin",
      inputFormat: pcm(24000),
      outputFormat: pcm(24000),
    })),
    Match.when("google", () => ({
      model: "gemini-3.1-flash-live-preview",
      instructions: INSTRUCTIONS,
      voiceId: "Kore",
      inputFormat: pcm(16000),
      outputFormat: pcm(24000),
    })),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// WebSocket bridge. Outbound, a binary frame is the model's audio and a text
// frame is status. Inbound, every frame arrives as bytes whatever the browser
// sent, so the client tags each one: the upgrade channel does not preserve the
// protocol's own text and binary distinction, and microphone PCM contains
// every byte value, so its content cannot be sniffed.
// ---------------------------------------------------------------------------

const AUDIO_FRAME = 0x00
const TEXT_FRAME = 0x01
/** Milliseconds of the current answer the browser actually played. */
const POSITION_FRAME = 0x02

const decoder = new TextDecoder()

const wsHandler = (cfg: AgentConfig) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[ws] browser connected")

    const micQueue = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>()
    const typedQueue = yield* Queue.unbounded<string, Cause.Done<void>>()
    const playedQueue = yield* Queue.unbounded<number, Cause.Done<void>>()
    const outQueue = yield* Queue.unbounded<string | Uint8Array, Cause.Done<void>>()

    yield* runAgent(cfg, toolkit, {
      mic: Stream.fromQueue(micQueue),
      typed: Stream.fromQueue(typedQueue),
      played: Stream.fromQueue(playedQueue),
      sendStatus: (event: StatusEvent) =>
        Effect.asVoid(Queue.offer(outQueue, JSON.stringify(event))),
      sendAudio: (bytes) => Effect.asVoid(Queue.offer(outQueue, bytes)),
    }).pipe(
      Effect.scoped,
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.logInfo("[agent] connection teardown")
          : Effect.logError("[agent] failed", { cause: Cause.pretty(cause) }),
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
        Match.when(POSITION_FRAME, () => {
          // A truncate is sent from this, so a garbled frame is dropped rather
          // than cutting the answer at `NaN` milliseconds.
          const playedMs = Number(decoder.decode(buf.subarray(1)))
          return Number.isFinite(playedMs) && playedMs >= 0
            ? Effect.asVoid(Queue.offer(playedQueue, playedMs))
            : Effect.void
        }),
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
          Effect.andThen(Queue.end(typedQueue), Queue.end(playedQueue)),
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
  readonly cfg: AgentConfig
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
          micSampleRate: assets.cfg.inputFormat.sampleRate,
          playbackSampleRate: assets.cfg.outputFormat.sampleRate,
        }),
        { contentType: "application/json; charset=utf-8" },
      ),
    ),
    HttpRouter.add("GET", "/ws", wsHandler(assets.cfg)),
  )

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const flags = yield* readFlags
  const cfg = configFor(flags.provider)

  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const clientJs = yield* bundleClient(path.join(recipeDir, "client/main.ts"))
  const micWorkletJs = yield* bundleClient(path.join(recipeDir, "client/mic-worklet.ts"))
  const playbackWorkletJs = yield* bundleClient(path.join(recipeDir, "client/playback-worklet.ts"))
  const indexHtml = yield* fs.readFileString(path.join(recipeDir, "client/index.html"))

  yield* Effect.logInfo(
    `realtime-voice-agent (${flags.provider}: ${cfg.model}, voice ${cfg.voiceId}, search ${flags.search})`,
  )

  // @effect-diagnostics-next-line effect/returnEffectInGen:off
  return Layer.launch(
    HttpRouter.serve(routesLayer({ cfg, indexHtml, clientJs, micWorkletJs, playbackWorkletJs })),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        realtimeSessionLayer({ provider: flags.provider, model: cfg.model }),
        webSearchLayer(flags.search),
      ),
    ),
  )
}).pipe(
  Effect.flatten,
  Effect.tapCause((cause) => Effect.logError("[main] fatal", { cause })),
)
