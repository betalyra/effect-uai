/**
 * Runner for the sandbox-code-interpreter recipe. Picks a provider via
 * `--provider <openai|anthropic|google>` (default: anthropic), boots a
 * Microsandbox microVM, and drives the conversation defined in `index.ts`.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... pnpm start
 *   OPENAI_API_KEY=...    pnpm start -- --provider openai
 *   GOOGLE_API_KEY=...    pnpm start -- --provider google
 */
import { Config, Effect, Layer, Logger, Match, References, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import * as Sandbox from "@effect-uai/core/Sandbox"
import * as Image from "@effect-uai/core/SandboxImage"
import * as Network from "@effect-uai/core/SandboxNetwork"
import * as Turn from "@effect-uai/core/Turn"
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { layer as microsandboxLayer } from "@effect-uai/microsandbox/MicrosandboxSandbox"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { conversation } from "./index.js"

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

const PROVIDERS = ["openai", "anthropic", "google"] as const
type ProviderName = (typeof PROVIDERS)[number]

interface PickedProvider {
  readonly label: string
  readonly model: string
  readonly service: LanguageModelService
}

const parseProviderArg = Effect.sync((): ProviderName => {
  const i = process.argv.indexOf("--provider")
  const raw = i >= 0 ? process.argv[i + 1] : undefined
  return (PROVIDERS as ReadonlyArray<string>).includes(raw ?? "")
    ? (raw as ProviderName)
    : "anthropic"
})

const openaiProvider = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("OPENAI_API_KEY")
  const service = yield* makeResponses({ apiKey })
  return {
    label: "openai/gpt-5.4-mini",
    model: "gpt-5.4-mini",
    service,
  } satisfies PickedProvider
})

const anthropicProvider = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("ANTHROPIC_API_KEY")
  const service = yield* makeAnthropic({ apiKey, defaultMaxTokens: 2048 })
  return {
    label: "anthropic/claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    service,
  } satisfies PickedProvider
})

const googleProvider = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
  const service = yield* makeGemini({ apiKey })
  return {
    label: "google/gemini-3-flash-preview",
    model: "gemini-3-flash-preview",
    service,
  } satisfies PickedProvider
})

const buildProvider = (name: ProviderName) =>
  Match.value(name).pipe(
    Match.when("openai", () => openaiProvider),
    Match.when("anthropic", () => anthropicProvider),
    Match.when("google", () => googleProvider),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const name = yield* parseProviderArg
  const provider = yield* buildProvider(name)
  yield* Effect.logInfo(`using ${provider.label}`)

  const sb = yield* Sandbox.create({
    image: Image.registry("python:3.12-slim"),
    network: Network.blocked,
  })
  yield* Effect.logInfo("sandbox ready")

  yield* Stream.runForEach(conversation(provider.service, provider.model, sb), (event) =>
    Match.value(event).pipe(
      Match.discriminators("_tag")({
        TurnComplete: ({ turn }) =>
          Effect.forEach(
            Turn.functionCalls(turn),
            (call) =>
              Effect.logInfo(`tool call: ${call.name}`, {
                call_id: call.call_id,
                input: call.arguments,
              }),
            { discard: true },
          ).pipe(
            Effect.andThen(
              Effect.logInfo("turn complete", {
                assistant: Turn.assistantTexts(turn).join(" "),
                stop_reason: turn.stop_reason,
              }),
            ),
          ),
      }),
      Match.when({ _tag: "Output" }, ({ result }) => Effect.logInfo("tool result", { result })),
      Match.when({ _tag: "Intermediate" }, () => Effect.void),
      Match.orElse(() => Effect.void),
    ),
  )
})

const mainLayer = Layer.mergeAll(
  microsandboxLayer({ defaultImage: "python:3.12-slim" }),
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
