/**
 * Composition + logging for the streaming-metrics recipe.
 *
 * Runtime-agnostic wiring lives here: the Gemini Flash provider Layer
 * (registering the generic `LanguageModel` tag), env-driven config (`MODEL`,
 * `PROMPT`, `OUTPUT_FILE`, `MAX_OUTPUT_TOKENS`), the metric log formatter, and
 * the bootstrap `main`. The runners (`run-node.ts`, `run-bun.ts`,
 * `run-deno.ts`) supply the platform `HttpClient` + `FileSystem`.
 *
 * `main` streams the metered story once. Story text deltas are written to the
 * output file as they arrive (via a scoped file handle, so the 20 pages are
 * never held in memory); only the metric samples are logged.
 */
import {
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Match,
  References,
  Stream,
} from "effect"
import * as Metrics from "@effect-uai/core/Metrics"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { fantasyStory } from "./recipe.js"

// ---------------------------------------------------------------------------
// Metric logging. The metered stream types its samples as the open
// `MetricEvent`; this recipe only emits the four built-ins, so we narrow to
// their union to format the typed fields.
// ---------------------------------------------------------------------------

type Sample =
  | Metrics.TimeToFirstToken
  | Metrics.Throughput
  | Metrics.TokenTotals
  | Metrics.TimeToCompletion

const fmt = (d: Duration.Duration): string => {
  const ms = Duration.toMillis(d)
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

const num = (n: number | undefined): string => (n === undefined ? "?" : String(n))

const formatMetric = (event: Metrics.MetricEvent): string =>
  Match.value(event as Sample).pipe(
    Match.tag("TimeToFirstToken", (e) => `TTFT        ${fmt(e.elapsed)} (${e.kind})`),
    Match.tag("Throughput", (e) => `throughput  ~${Math.round(e.ratePerSecond)} ${e.unit}/s`),
    Match.tag("TokenTotals", (e) => {
      // Reasoning ("thinking") tokens are billed separately and explain why
      // total can exceed input + output on models like gemini-2.5-flash.
      const reasoning = e.usage.output_tokens_details?.reasoning_tokens
      const reasoningStr = reasoning === undefined ? "" : ` reasoning=${reasoning}`
      return `tokens      in=${num(e.usage.input_tokens)} out=${num(e.usage.output_tokens)}${reasoningStr} total=${num(e.usage.total_tokens)}`
    }),
    Match.tag(
      "TimeToCompletion",
      (e) => `completed   ${fmt(e.duration)} total, ${fmt(e.generation)} generating`,
    ),
    Match.exhaustive,
  )

const logMetric = (event: Metrics.MetricEvent): Effect.Effect<void> =>
  Console.log(formatMetric(event))

// ---------------------------------------------------------------------------
// Recipe config (env-driven via Config).
// ---------------------------------------------------------------------------

const recipeConfig = Config.all({
  model: Config.string("MODEL").pipe(Config.withDefault("gemini-2.5-flash")),
  prompt: Config.string("PROMPT").pipe(
    Config.withDefault(
      "Write an epic high-fantasy story about a reluctant cartographer whose maps redraw themselves to reveal a kingdom that was deliberately erased from history.",
    ),
  ),
  outputFile: Config.string("OUTPUT_FILE").pipe(Config.withDefault("fantasy-story.txt")),
  maxOutputTokens: Config.int("MAX_OUTPUT_TOKENS").pipe(Config.withDefault(65536)),
})

// ---------------------------------------------------------------------------
// Bootstrap: stream the metered story once, write deltas to the file, log the
// metric samples as they arrive.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const cfg = yield* recipeConfig

  yield* Effect.logInfo(`Generating a ~20 page fantasy story with ${cfg.model}...`)

  const file = yield* fs.open(cfg.outputFile, { flag: "w" })
  const encoder = new TextEncoder()

  yield* fantasyStory(cfg).pipe(
    Stream.runForEach((event) =>
      Metrics.isMetricEvent(event)
        ? logMetric(event)
        : event._tag === "TextDelta"
          ? Effect.asVoid(file.write(encoder.encode(event.text)))
          : Effect.void,
    ),
  )

  yield* Effect.logInfo(`Story written to ${cfg.outputFile}`)
}).pipe(
  Effect.scoped,
  Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })),
)

// ---------------------------------------------------------------------------
// App-level layer: the Gemini provider (against the generic `LanguageModel`
// tag) + logging. Runners merge this with their platform `HttpClient` +
// `FileSystem` and call `runMain`.
// ---------------------------------------------------------------------------

const geminiProviderLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return geminiLayer({ apiKey })
  }),
)

const logLevelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
    return Layer.succeed(References.MinimumLogLevel, level)
  }),
)

export const appLayer = Layer.mergeAll(
  geminiProviderLayer,
  Logger.layer([Logger.consolePretty()]),
  logLevelLayer,
)
