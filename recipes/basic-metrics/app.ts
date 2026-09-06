/**
 * Composition + logging for the streaming-metrics recipe.
 *
 * Runtime-agnostic wiring lives here: flags (`--model`, `--prompt`,
 * `--max-tokens`, `--out`), the provider Layer resolved from the model spec,
 * the metric log formatter, and the bootstrap `main`. `run.ts` supplies the
 * platform `HttpClient` + `FileSystem`.
 *
 * `main` streams the metered story once. Story text deltas are written to the
 * output file as they arrive (via a scoped file handle, so the 20 pages are
 * never held in memory); only the metric samples are logged.
 */
import { Console, Duration, Effect, FileSystem, Match, Option, Stdio, Stream } from "effect"
import * as Metrics from "@effect-uai/core/Metrics"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { runDir } from "@effect-uai/recipe-kit/output"
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
// Flags
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT =
  "Write an epic high-fantasy story about a reluctant cartographer whose maps redraw themselves to reveal a kingdom that was deliberately erased from history."

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    spec: parseModelSpec(
      Option.getOrElse(flagValue("model", argv), () => "gemini-2.5-flash"),
      "google",
    ),
    prompt: Option.getOrElse(flagValue("prompt", argv), () => DEFAULT_PROMPT),
    outDir: yield* runDir("basic-metrics", argv),
    maxOutputTokens: intFlag("max-tokens", argv, 65536),
  }
})

// ---------------------------------------------------------------------------
// Bootstrap: stream the metered story once, write deltas to the file, log the
// metric samples as they arrive.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const flags = yield* readFlags
  const story = `${flags.outDir}/story.txt`

  yield* Effect.logInfo(`Generating a ~20 page fantasy story with ${flags.spec.model}...`)

  yield* fs.makeDirectory(flags.outDir, { recursive: true })
  const file = yield* fs.open(story, { flag: "w" })
  const encoder = new TextEncoder()

  yield* fantasyStory({ ...flags, model: flags.spec.model }).pipe(
    Stream.runForEach((event) =>
      Metrics.isMetricEvent(event)
        ? logMetric(event)
        : event._tag === "TextDelta"
          ? Effect.asVoid(file.write(encoder.encode(event.text)))
          : Effect.void,
    ),
    Effect.provide(languageModelLayer(flags.spec)),
  )

  yield* Effect.logInfo(`Story written to ${story}`)
}).pipe(
  Effect.scoped,
  Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })),
)
