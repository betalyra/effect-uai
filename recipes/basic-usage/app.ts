/**
 * Composition + rendering for the basic-usage recipe.
 *
 * Runtime-agnostic wiring lives here: the provider Layer (a chat-completions
 * gateway, registering the generic `LanguageModel` tag), CLI flags
 * (`--model`, `--base-url`, `--provider`), the secret (`LLM_API_KEY`, from env),
 * the chat-style renderer, and the bootstrap `main`. The runners supply the
 * platform `HttpClient`.
 *
 * The provider is a chat-completions gateway (default OpenRouter), so this same
 * recipe runs against any OpenAI-compatible endpoint by pointing `--base-url`
 * and `--model` at it.
 */
import { Config, Effect, Layer, Logger, Match, Option, References, Stream } from "effect"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { make as makeChat } from "@effect-uai/chat-completions/ChatCompletions"
import { make as makeMistral } from "@effect-uai/mistral/Mistral"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { flagValue } from "../_shared/argv.js"
import { renderEvent } from "../_shared/render.js"
import { makeConversation } from "./recipe.js"

// ---------------------------------------------------------------------------
// CLI flags. Defaults target OpenRouter; point them at any OpenAI-compatible
// gateway. `--dialect` picks the wire protocol (chat-completions vs the OpenAI
// Responses API, both appended to the same `--base-url`). The API key stays in
// the env (`LLM_API_KEY`).
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const model = Option.getOrElse(flagValue("model", argv), () => "openai/gpt-4o-mini")
const baseUrl = Option.getOrElse(flagValue("base-url", argv), () => "https://openrouter.ai/api/v1")
const provider = Option.getOrElse(flagValue("provider", argv), () => "openrouter")
const dialect = Option.getOrElse(flagValue("dialect", argv), () => "chat")

// ---------------------------------------------------------------------------
// Bootstrap: run the conversation once, rendering events as they stream via
// the shared console renderer.
// ---------------------------------------------------------------------------

export const main = Stream.runForEach(makeConversation(model), renderEvent()).pipe(
  Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })),
)

// ---------------------------------------------------------------------------
// App-level layer: the chat-completions provider (against the generic
// `LanguageModel` tag) + logging. Runners merge this with their platform
// `HttpClient`.
// ---------------------------------------------------------------------------

const providerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("LLM_API_KEY")
    const service = yield* Match.value(dialect).pipe(
      Match.when("responses", () => makeResponses({ apiKey, baseUrl })),
      Match.when("mistral", () => makeMistral({ apiKey })), // Mistral's typed layer + base URL
      Match.orElse(() => makeChat({ apiKey, baseUrl, provider })),
    )
    return Layer.succeed(LanguageModel, service)
  }),
)

const logLevelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
    return Layer.succeed(References.MinimumLogLevel, level)
  }),
)

export const appLayer = Layer.mergeAll(
  providerLayer,
  Logger.layer([Logger.consolePretty()]),
  logLevelLayer,
)
