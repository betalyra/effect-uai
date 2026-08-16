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
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { flagValue } from "../_shared/argv.js"
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
// Rendering. Print straight to stdout so the demo reads like a chat: assistant
// text streams in token by token, tool calls and their results show inline.
// ---------------------------------------------------------------------------

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

// ---------------------------------------------------------------------------
// Bootstrap: run the conversation once, rendering events as they stream.
// ---------------------------------------------------------------------------

export const main = Stream.runForEach(makeConversation(model), (event) =>
  Match.value(event).pipe(
    // Assistant prose, as it streams.
    Match.tag("TextDelta", ({ text }) => write(text)),
    // A tool call: name in cyan, JSON arguments stream in plain text after.
    Match.tag("ToolCallStart", ({ name }) => write(`\n${cyan(`🔧 ${name}`)} `)),
    Match.tag("ToolCallArgsDelta", ({ delta }) => write(delta)),
    // The tool's result, dim under its call.
    Match.tag("Output", ({ result }) =>
      write(
        dim(
          `   ↳ ${result._tag === "Ok" ? JSON.stringify(result.value) : `failed: ${result.kind}`}`,
        ) + "\n",
      ),
    ),
    // End of a turn: reset any dim styling and break the line.
    Match.tag("TurnComplete", () => write("\x1b[0m\n")),
    Match.orElse(() => Effect.void),
  ),
).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))

// ---------------------------------------------------------------------------
// App-level layer: the chat-completions provider (against the generic
// `LanguageModel` tag) + logging. Runners merge this with their platform
// `HttpClient`.
// ---------------------------------------------------------------------------

const providerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("LLM_API_KEY")
    const service =
      dialect === "responses"
        ? yield* makeResponses({ apiKey, baseUrl })
        : yield* makeChat({ apiKey, baseUrl, provider })
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
