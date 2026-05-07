/**
 * Streaming objects via prompted JSONL. The model is asked to emit one
 * JSON object per line; each line is validated against the schema as it
 * arrives. This is *not* server-enforced — there's no wire format that
 * makes JSONL native. Compose three primitives:
 *
 *   textDeltas         (TurnEvent stream → text fragments)
 *   lines              (text fragments → newline-delimited lines)
 *   decodeJsonLines    (lines → typed, validated objects)
 *
 * Each operator's failures are surfaced in the stream channel with a
 * distinct tag (`JsonParseError`, `StructuredDecodeError`), so the
 * caller picks the policy: fail-fast, skip-bad, log-and-continue.
 *
 * Switch providers via `--provider`:
 *
 *   pnpm tsx recipes/structured-output/streaming.ts --provider=responses
 *   pnpm tsx recipes/structured-output/streaming.ts --provider=anthropic
 *   pnpm tsx recipes/structured-output/streaming.ts --provider=gemini
 *
 * Caveat: prompt-driven JSONL is fragile. Models sometimes pretty-print
 * (newlines inside objects) or wrap output in code fences. This recipe
 * uses an explicit example in the prompt to anchor the format. For
 * server-enforced shape, use the single-object pattern in `index.ts`.
 */
import { Config, Effect, Layer, Logger, Match, References, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import * as Lines from "@effect-uai/core/Lines"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"
import { layer as anthropicLayer } from "@effect-uai/anthropic/Anthropic"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})
type Recipe = typeof Recipe.Type

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const prompt = [
  "Give me 3 short cooking recipes as JSONL: one JSON object per line, no prose, no code fences.",
  `Example: {"title":"Lemon Chicken","ingredients":["chicken","lemon"],"prepMinutes":10}`,
].join("\n")

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = (model: string) =>
  streamTurn({ history: [Items.userText(prompt)], model }).pipe(
    Turn.textDeltas,
    Lines.lines,
    StructuredFormat.decodeJsonLines(recipeFormat),
    Stream.tap((recipe: Recipe) => Effect.logInfo("recipe (streamed)", { recipe })),
    Stream.runDrain,
  )

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

type Provider = "responses" | "anthropic" | "gemini"

const parseProvider = (argv: ReadonlyArray<string>): Provider => {
  const flag =
    argv.find((a) => a.startsWith("--provider="))?.slice("--provider=".length) ?? "responses"
  return Match.value(flag).pipe(
    Match.when("responses", () => "responses" as const),
    Match.when("anthropic", () => "anthropic" as const),
    Match.when("gemini", () => "gemini" as const),
    Match.orElse(() => {
      throw new Error(`unknown provider: ${flag} (expected responses|anthropic|gemini)`)
    }),
  )
}

const modelFor = (provider: Provider): string =>
  Match.value(provider).pipe(
    Match.when("responses", () => "gpt-5.4-mini"),
    Match.when("anthropic", () => "claude-sonnet-4-5"),
    Match.when("gemini", () => "gemini-2.5-flash"),
    Match.exhaustive,
  )

const languageModelLayer = (provider: Provider) =>
  Match.value(provider).pipe(
    Match.when("responses", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("OPENAI_API_KEY")
          return responsesLayer({ apiKey })
        }),
      ),
    ),
    Match.when("anthropic", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY")
          return anthropicLayer({ apiKey })
        }),
      ),
    ),
    Match.when("gemini", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
          return geminiLayer({ apiKey })
        }),
      ),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const provider = parseProvider(process.argv.slice(2))

const runtime = Layer.mergeAll(
  languageModelLayer(provider).pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program(modelFor(provider)).pipe(
    Effect.tap(() => Effect.logInfo(`provider: ${provider}`)),
    Effect.provide(runtime),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("streaming recipe failed:", err)
  process.exit(1)
})
