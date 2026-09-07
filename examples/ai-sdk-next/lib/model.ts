/**
 * Provider selection, from the environment rather than from code.
 *
 *   LLM_PROVIDER=requesty|openai|anthropic|google   (default: requesty)
 *   LLM_MODEL / LLM_FALLBACK_MODEL                  (default: per provider)
 *   LLM_BASE_URL                                    (requesty and openai)
 *
 * Requesty and OpenAI are the same wire protocol, so they share the Responses
 * adapter and differ only in base URL and key. Anthropic and Gemini speak
 * their own, so they get their own `make`. Each provider reads its own key,
 * falling back to `LLM_API_KEY`.
 */
import { make as makeAnthropic } from "@effect-uai/anthropic/Anthropic"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import { make as makeGemini } from "@effect-uai/google/Gemini"
import { make as makeResponses } from "@effect-uai/responses/Responses"
import { Config, Effect, Match } from "effect"
import type { HttpClient } from "effect/unstable/http"

type Provider = "requesty" | "openai" | "anthropic" | "google"

/**
 * Primary and fallback tier per provider. The app has a tool, so every default
 * here has to survive a function call: some cheap gateway routes stream a tool
 * call and then drop the connection before completing the turn.
 */
const defaults: Record<Provider, { readonly model: string; readonly fallback: string }> = {
  requesty: {
    model: "vertex/gemini-3.8-flash@eu",
    fallback: "tensorx/deepseek-v4-flash-0731",
  },
  openai: { model: "gpt-5.6-terra", fallback: "gpt-5.6-luna" },
  anthropic: {
    model: "claude-haiku-4-5-20251001",
    fallback: "claude-sonnet-4-6",
  },
  google: { model: "gemini-3-flash-preview", fallback: "gemini-2.5-flash" },
}

const key = (name: string) =>
  Config.redacted(name).pipe(Config.orElse(() => Config.redacted("LLM_API_KEY")))

/** `LLM_BASE_URL` wins; otherwise the gateway's own endpoint. */
const responses = (keyName: string, defaultBaseUrl?: string) =>
  Effect.gen(function* () {
    const apiKey = yield* key(keyName)
    const baseUrl = yield* Config.string("LLM_BASE_URL").pipe(Config.withDefault(defaultBaseUrl))
    return yield* makeResponses({
      apiKey,
      ...(baseUrl !== undefined && { baseUrl }),
    })
  })

const serviceFor = (
  provider: Provider,
): Effect.Effect<LanguageModelService, Config.ConfigError, HttpClient.HttpClient> =>
  Match.value(provider).pipe(
    Match.when("openai", () => responses("OPENAI_API_KEY")),
    Match.when("anthropic", () =>
      Effect.flatMap(key("ANTHROPIC_API_KEY"), (apiKey) =>
        makeAnthropic({ apiKey, defaultMaxTokens: 4096 }),
      ),
    ),
    Match.when("google", () =>
      Effect.flatMap(key("GOOGLE_API_KEY"), (apiKey) => makeGemini({ apiKey })),
    ),
    Match.orElse(() => responses("REQUESTY_API_KEY", "https://router.eu.requesty.ai/v1")),
  )

/** One service and the two model ids the route's fallback loop steps through. */
export const readProvider = Effect.gen(function* () {
  const provider = yield* Config.literals(
    ["requesty", "openai", "anthropic", "google"],
    "LLM_PROVIDER",
  ).pipe(Config.withDefault("requesty" as const))
  const service = yield* serviceFor(provider)
  return {
    service,
    model: yield* Config.string("LLM_MODEL").pipe(Config.withDefault(defaults[provider].model)),
    fallback: yield* Config.string("LLM_FALLBACK_MODEL").pipe(
      Config.withDefault(defaults[provider].fallback),
    ),
  }
})
