/**
 * `provider:model` selection for this recipe.
 *
 *   --video-model fal:minimax/h3-max-turbo/text-to-video
 *   --image-model fal:fal-ai/flux/schnell
 *   --planner-model anthropic:claude-sonnet-5
 *   --planner-model gpt-5.4-mini          # no colon: the default provider
 *   --search-provider tavily
 *
 * A trimmed local copy rather than `recipes/_shared/model.ts`: this folder
 * is outside the workspace and links its dependencies one by one, so a
 * registry of every provider would mean linking every provider.
 */
import { Config, Data, Effect, Layer, type Redacted } from "effect"
import { HttpClient } from "effect/unstable/http"
import { layer as anthropicLayer } from "@effect-uai/anthropic/Anthropic"
import { layer as exaSearchLayer } from "@effect-uai/exa/ExaSearch"
import { layer as falImageLayer } from "@effect-uai/fal/FalImageGenerator"
import { layer as falVideoLayer } from "@effect-uai/fal/FalVideoGenerator"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { layer as tavilySearchLayer } from "@effect-uai/tavily/TavilySearch"
import type { ImageGenerator } from "@effect-uai/core/ImageGenerator"
import type { LanguageModel } from "@effect-uai/core/LanguageModel"
import type { VideoGenerator } from "@effect-uai/core/VideoGenerator"
import type { WebSearch } from "@effect-uai/core/WebSearch"

export class UnknownProvider extends Data.TaggedError("UnknownProvider")<{
  readonly provider: string
  readonly expected: string
}> {}

export type ModelSpec = {
  readonly provider: string
  readonly model: string
}

/**
 * Split on the first colon only. Endpoint ids carry slashes and gateway
 * ids carry further colons, so a naive split breaks them.
 */
export const parseModelSpec = (spec: string, defaultProvider: string): ModelSpec => {
  const at = spec.indexOf(":")
  return at === -1
    ? { provider: defaultProvider, model: spec }
    : { provider: spec.slice(0, at), model: spec.slice(at + 1) }
}

type Entry<L> = {
  readonly layer: (apiKey: Redacted.Redacted) => L
  readonly apiKey: Effect.Effect<Redacted.Redacted, Config.ConfigError>
}

const lookup = <L>(
  provider: string,
  entries: Record<string, Entry<L>>,
): Effect.Effect<L, Config.ConfigError | UnknownProvider> => {
  const entry = entries[provider]
  return entry === undefined
    ? Effect.fail(
        new UnknownProvider({ provider, expected: Object.keys(entries).sort().join(" | ") }),
      )
    : Effect.map(entry.apiKey, entry.layer)
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const llmEntries: Record<
  string,
  Entry<Layer.Layer<LanguageModel, never, HttpClient.HttpClient>>
> = {
  openai: {
    layer: (apiKey) => responsesLayer({ apiKey }),
    apiKey: Config.redacted("OPENAI_API_KEY"),
  },
  anthropic: {
    layer: (apiKey) => anthropicLayer({ apiKey }),
    apiKey: Config.redacted("ANTHROPIC_API_KEY"),
  },
  google: {
    layer: (apiKey) => geminiLayer({ apiKey }),
    apiKey: Config.redacted("GOOGLE_API_KEY"),
  },
}

// The model is an endpoint path, so it carries slashes:
// `--video-model fal:minimax/h3-max-turbo/text-to-video`.
const videoEntries: Record<
  string,
  Entry<Layer.Layer<VideoGenerator, never, HttpClient.HttpClient>>
> = {
  fal: {
    layer: (apiKey) => falVideoLayer({ apiKey }),
    apiKey: Config.redacted("FAL_API_KEY"),
  },
}

/** Only the standby card, so one fast cheap endpoint is the whole list. */
const imageEntries: Record<
  string,
  Entry<Layer.Layer<ImageGenerator, never, HttpClient.HttpClient>>
> = {
  fal: {
    layer: (apiKey) => falImageLayer({ apiKey }),
    apiKey: Config.redacted("FAL_API_KEY"),
  },
}

/** Search takes no model of its own, so the flag is a bare provider name. */
const searchEntries: Record<string, Entry<Layer.Layer<WebSearch, never, HttpClient.HttpClient>>> = {
  exa: {
    layer: (apiKey) => exaSearchLayer({ apiKey }),
    apiKey: Config.redacted("EXA_API_KEY"),
  },
  tavily: {
    layer: (apiKey) => tavilySearchLayer({ apiKey }),
    apiKey: Config.redacted("TAVILY_API_KEY"),
  },
}

export const languageModelLayer = (
  spec: ModelSpec,
): Layer.Layer<LanguageModel, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(lookup(spec.provider, llmEntries))

export const videoGeneratorLayer = (
  spec: ModelSpec,
): Layer.Layer<VideoGenerator, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(lookup(spec.provider, videoEntries))

export const imageGeneratorLayer = (
  spec: ModelSpec,
): Layer.Layer<ImageGenerator, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(lookup(spec.provider, imageEntries))

export const webSearchLayer = (
  provider: string,
): Layer.Layer<WebSearch, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(lookup(provider, searchEntries))
