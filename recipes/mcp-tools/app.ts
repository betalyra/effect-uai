/**
 * Composition + rendering for the mcp-tools recipe.
 *
 * Defaults point at Hugging Face's MCP server: public and keyless. Point
 * `--mcp-url` at any other Streamable HTTP server and it still works: the
 * protocol version is negotiated at connect rather than configured here.
 *
 * Streamable HTTP only, so the recipe needs an `HttpClient` and the platform
 * services layer, and runs identically on Node, Bun and Deno. A local stdio
 * server additionally needs a `ChildProcessSpawner`; the docs page covers it.
 *
 * Flags are read through Effect's `Stdio` service rather than `process.argv`,
 * so nothing here is Node-specific. Model selection is deliberately minimal:
 * `--model` / `--base-url` against the Responses API.
 */
import { Config, Effect, Layer, Logger, Option, References, Stdio, Stream } from "effect"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { Auth, type McpClientConfig } from "@effect-uai/mcp/Client"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { flagValue } from "../_shared/argv.js"
import { renderEvent } from "../_shared/render.js"
import { makeConversation } from "./recipe.js"

type Flags = {
  readonly model: string
  readonly baseUrl: string
  readonly mcp: McpClientConfig
  readonly prefix: string
  readonly prompt: string
}

/**
 * `--mcp-token-env NAME` names the environment variable holding the server's
 * token, rather than taking the secret on the command line where it would show
 * up in `ps` and shell history. Absent or unset means an unauthenticated
 * connection, which is what public servers want.
 */
const readAuth = (argv: ReadonlyArray<string>) =>
  Config.option(
    Config.redacted(Option.getOrElse(flagValue("mcp-token-env", argv), () => "MCP_TOKEN")),
  ).pipe(
    Effect.map(Option.map((token) => Auth.Static({ token }))),
    Effect.orElseSucceed(() => Option.none<Auth>()),
  )

const readFlags: Effect.Effect<Flags, never, Stdio.Stdio> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const auth = yield* readAuth(argv)
  return {
    model: Option.getOrElse(flagValue("model", argv), () => "openai/gpt-4o-mini"),
    baseUrl: Option.getOrElse(flagValue("base-url", argv), () => "https://openrouter.ai/api/v1"),
    mcp: {
      transport: "http",
      url: Option.getOrElse(flagValue("mcp-url", argv), () => "https://huggingface.co/mcp"),
      ...Option.match(auth, { onNone: () => ({}), onSome: (a) => ({ auth: a }) }),
    },
    prefix: Option.getOrElse(flagValue("prefix", argv), () => "hf"),
    prompt: Option.getOrElse(
      flagValue("prompt", argv),
      () =>
        "Find two popular Whisper speech-to-text models on Hugging Face and compare them briefly.",
    ),
  }
})

/**
 * The language model, built from the same flags the conversation uses. Read
 * inside the program (not at module scope) so the flags have one source.
 */
const languageModel = (flags: Flags) =>
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("LLM_API_KEY")
    return yield* makeResponses({ apiKey, baseUrl: flags.baseUrl })
  })

// MCP tool results are prose-heavy, so cap what the terminal echoes.
export const main = Effect.gen(function* () {
  const flags = yield* readFlags
  const model = yield* languageModel(flags)
  yield* Stream.runForEach(
    makeConversation(flags.mcp, flags.model, flags.prompt, flags.prefix),
    renderEvent({ maxResultChars: 300 }),
  ).pipe(Effect.provideService(LanguageModel, model))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))

/** Logging only; the model is provided inside `main` from the parsed flags. */
export const appLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  Layer.unwrap(
    Effect.gen(function* () {
      const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
      return Layer.succeed(References.MinimumLogLevel, level)
    }),
  ),
)
