/**
 * `provider:model` selection for recipe runners.
 *
 *   --model anthropic:claude-sonnet-5
 *   --model requesty:vertex/google/gemini-3.1-flash-image
 *   --model gpt-5.2                    # no colon: the recipe's default provider
 *
 * A recipe names the generic capability tag; this file is the only place
 * that knows which package, base URL and env var a given provider needs.
 * Internal to `recipes/`: provider selection is runner ergonomics, and the
 * library stays unopinionated about which provider you wire.
 */
import { Config, Data, Effect, Layer, type Redacted } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { layer as anthropicLayer } from "@effect-uai/anthropic/Anthropic"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { layer as geminiImageLayer } from "@effect-uai/google/GeminiImageGenerator"
import { layer as mistralLayer } from "@effect-uai/mistral/Mistral"
import { layer as openaiImageLayer } from "@effect-uai/openai/OpenAIImageGenerator"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import type { ImageGenerator } from "@effect-uai/core/ImageGenerator"
import type { LanguageModel } from "@effect-uai/core/LanguageModel"

/** The spec named a provider no registry has an entry for. */
export class UnknownProvider extends Data.TaggedError("UnknownProvider")<{
  readonly spec: string
  readonly provider: string
  readonly expected: string
}> {}

export type ModelSpec = {
  readonly provider: string
  readonly model: string
}

/**
 * Split on the **first** colon only. OpenRouter model ids legitimately
 * contain colons (`meta-llama/llama-3-8b:free`), so a naive split breaks
 * them. No colon means the caller's default provider, which keeps a bare
 * `--model gpt-5.2` working.
 */
export const parseModelSpec = (spec: string, defaultProvider: string): ModelSpec => {
  const at = spec.indexOf(":")
  return at === -1
    ? { provider: defaultProvider, model: spec }
    : { provider: spec.slice(0, at), model: spec.slice(at + 1) }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * A gateway's own key, falling back to `LLM_API_KEY` so one variable can
 * drive a whole run. Direct providers get no fallback: reaching OpenAI with
 * an Anthropic key should say so, not 401 halfway through.
 */
const key = (
  primary: string,
  fallback?: string,
): Effect.Effect<Redacted.Redacted, Config.ConfigError> =>
  fallback === undefined
    ? Config.redacted(primary)
    : Config.redacted(primary).pipe(Config.orElse(() => Config.redacted(fallback)))

type Entry<L> = {
  /** `baseUrl` is the caller's override; each entry supplies its own default. */
  readonly layer: (apiKey: Redacted.Redacted, baseUrl: string | undefined) => L
  readonly apiKey: Effect.Effect<Redacted.Redacted, Config.ConfigError>
}

const registry = <L>(
  spec: ModelSpec,
  baseUrl: string | undefined,
  entries: Record<string, Entry<L>>,
): Effect.Effect<L, Config.ConfigError | UnknownProvider> => {
  const entry = entries[spec.provider]
  return entry === undefined
    ? Effect.fail(
        new UnknownProvider({
          spec: `${spec.provider}:${spec.model}`,
          provider: spec.provider,
          expected: Object.keys(entries).join(" | "),
        }),
      )
    : Effect.map(entry.apiKey, (apiKey) => entry.layer(apiKey, baseUrl))
}

/** `exactOptionalPropertyTypes` forbids passing `baseUrl: undefined`. */
const at = (baseUrl: string | undefined) => (baseUrl === undefined ? {} : { baseUrl })

const REQUESTY = "https://router.requesty.ai/v1"
const OPENROUTER = "https://openrouter.ai/api/v1"

// ---------------------------------------------------------------------------
// Language models
//
// Responses wherever it is available, gateways included: both document the
// endpoint, so one wire protocol covers four of the six entries. The direct
// provider keys stay because the recipes are also a showcase for the typed
// packages, and routing everything through a gateway leaves them unexercised.
// ---------------------------------------------------------------------------

type LlmLayer = Layer.Layer<LanguageModel, never, HttpClient.HttpClient>

const llmEntries: Record<string, Entry<LlmLayer>> = {
  openai: {
    layer: (apiKey, baseUrl) => responsesLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("OPENAI_API_KEY"),
  },
  openrouter: {
    layer: (apiKey, baseUrl) => responsesLayer({ apiKey, baseUrl: baseUrl ?? OPENROUTER }),
    apiKey: key("OPENROUTER_API_KEY", "LLM_API_KEY"),
  },
  requesty: {
    layer: (apiKey, baseUrl) => responsesLayer({ apiKey, baseUrl: baseUrl ?? REQUESTY }),
    apiKey: key("REQUESTY_API_KEY", "LLM_API_KEY"),
  },
  // Anthropic requires `max_tokens` on every request; the adapter's own
  // default only applies when the request omits one.
  anthropic: {
    layer: (apiKey, baseUrl) => anthropicLayer({ apiKey, defaultMaxTokens: 8192, ...at(baseUrl) }),
    apiKey: key("ANTHROPIC_API_KEY"),
  },
  google: {
    layer: (apiKey, baseUrl) => geminiLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("GOOGLE_API_KEY"),
  },
  mistral: {
    layer: (apiKey, baseUrl) => mistralLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("MISTRAL_API_KEY"),
  },
}

/** `LanguageModel` for one spec. The typed provider tag is registered too. */
export const languageModelLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<LanguageModel, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(registry(spec, baseUrl, llmEntries))

// ---------------------------------------------------------------------------
// Image generators
//
// Two wire protocols rather than one: OpenAI's Images API and Gemini's
// `generateContent`. Gateways speak the OpenAI one, so they reuse that
// adapter with a base URL, exactly as they do for chat.
// ---------------------------------------------------------------------------

type ImageLayer = Layer.Layer<ImageGenerator, never, HttpClient.HttpClient>

const imageEntries: Record<string, Entry<ImageLayer>> = {
  openai: {
    layer: (apiKey, baseUrl) => openaiImageLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("OPENAI_API_KEY"),
  },
  openrouter: {
    layer: (apiKey, baseUrl) => openaiImageLayer({ apiKey, baseUrl: baseUrl ?? OPENROUTER }),
    apiKey: key("OPENROUTER_API_KEY", "LLM_API_KEY"),
  },
  requesty: {
    layer: (apiKey, baseUrl) => openaiImageLayer({ apiKey, baseUrl: baseUrl ?? REQUESTY }),
    apiKey: key("REQUESTY_API_KEY", "LLM_API_KEY"),
  },
  google: {
    layer: (apiKey, baseUrl) => geminiImageLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("GOOGLE_API_KEY"),
  },
}

/** `ImageGenerator` for one spec. The typed provider tag is registered too. */
export const imageGeneratorLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<ImageGenerator, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(registry(spec, baseUrl, imageEntries))
