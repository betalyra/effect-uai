/**
 * Drive a Responses / Anthropic / Gemini conversation against a JSON
 * Schema and validate the model's output. Server enforces the schema;
 * `Turn.toStructured` is the local safety net that surfaces wire-level
 * surprises as `StructuredDecodeError`.
 *
 * Switch providers via `--provider`:
 *
 *   pnpm tsx recipes/structured-output/index.ts --provider=responses
 *   pnpm tsx recipes/structured-output/index.ts --provider=anthropic
 *   pnpm tsx recipes/structured-output/index.ts --provider=gemini
 *
 * Requires the matching API key in the environment
 * (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`).
 */
import {
  Config,
  Effect,
  Layer,
  Logger,
  Match,
  References,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as Items from "@effect-uai/core/Items";
import { turn as runTurn } from "@effect-uai/core/LanguageModel";
import * as StructuredFormat from "@effect-uai/core/StructuredFormat";
import * as Turn from "@effect-uai/core/Turn";
import { layer as anthropicLayer } from "@effect-uai/anthropic";
import { layer as geminiLayer } from "@effect-uai/google";
import { layer as responsesLayer } from "@effect-uai/responses";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
});
type Recipe = typeof Recipe.Type;

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe);

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const turn = yield* runTurn(
    [Items.userText("Give me a recipe for one-pan lemon chicken.")],
    {
      structured: recipeFormat,
    },
  );
  const recipe = yield* Turn.toStructured(turn, recipeFormat);
  yield* Effect.logInfo("recipe", { recipe });
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

type Provider = "responses" | "anthropic" | "gemini";

const parseProvider = (argv: ReadonlyArray<string>): Provider => {
  const flag =
    argv
      .find((a) => a.startsWith("--provider="))
      ?.slice("--provider=".length) ?? "responses";
  return Match.value(flag).pipe(
    Match.when("responses", () => "responses" as const),
    Match.when("anthropic", () => "anthropic" as const),
    Match.when("gemini", () => "gemini" as const),
    Match.orElse(() => {
      throw new Error(
        `unknown provider: ${flag} (expected responses|anthropic|gemini)`,
      );
    }),
  );
};

const languageModelLayer = (provider: Provider) =>
  Match.value(provider).pipe(
    Match.when("responses", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("OPENAI_API_KEY");
          return responsesLayer({ apiKey, model: "gpt-5.4-mini" });
        }),
      ),
    ),
    Match.when("anthropic", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY");
          return anthropicLayer({ apiKey, model: "claude-sonnet-4-5" });
        }),
      ),
    ),
    Match.when("gemini", () =>
      Layer.unwrap(
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted("GOOGLE_API_KEY");
          return geminiLayer({ apiKey, model: "gemini-2.5-flash" });
        }),
      ),
    ),
    Match.exhaustive,
  );

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const provider = parseProvider(process.argv.slice(2));

const runtime = Layer.mergeAll(
  languageModelLayer(provider).pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
);

Effect.runPromise(
  program.pipe(
    Effect.tap(() => Effect.logInfo(`provider: ${provider}`)),
    Effect.provide(runtime),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err);
  process.exit(1);
});
