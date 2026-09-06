/**
 * Composition for the sandbox-code-interpreter recipe. `--provider` picks
 * which model drives the loop; the Microsandbox microVM is the same either
 * way. Each provider is built as a live service rather than a Layer, so the
 * wiring stays here rather than going through a registry.
 */
import { Config, Effect, Layer, Match, Stream } from "effect"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import * as Sandbox from "@effect-uai/core/Sandbox"
import * as Image from "@effect-uai/core/SandboxImage"
import * as Network from "@effect-uai/core/SandboxNetwork"
import * as Turn from "@effect-uai/core/Turn"
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { layer as microsandboxLayer } from "@effect-uai/microsandbox/MicrosandboxSandbox"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { providerChoice } from "@effect-uai/recipe-kit/argv"
import { conversation } from "./recipe.js"

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

export const main = Effect.gen(function* () {
  const name = yield* providerChoice("anthropic", "openai", "google")
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
            Turn.getToolCalls(turn),
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
      Match.when({ _tag: "Progress" }, () => Effect.void),
      Match.orElse(() => Effect.void),
    ),
  )
}).pipe(
  Effect.scoped,
  Effect.provide(microsandboxLayer({ defaultImage: "python:3.12-slim" })),
  Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })),
)
