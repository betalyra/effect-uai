/**
 * `provider:model` selection for recipe runners.
 *
 *   --model anthropic:claude-sonnet-5
 *   --model requesty:vertex/google/gemini-3.1-flash-image
 *   --model gpt-5.2                    # no colon: the recipe's default provider
 *
 * Capabilities that have no model of their own (web search, web read, a
 * browser) take a bare provider name instead: `--search exa`.
 *
 * A recipe names the generic capability tag; this file is the only place
 * that knows which package, base URL and env var a given provider needs.
 * Internal to `recipes/`: provider selection is runner ergonomics, and the
 * library stays unopinionated about which provider you wire.
 */
import { Config, Data, Effect, Layer, type Redacted, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import type * as Socket from "effect/unstable/socket/Socket"
import { layer as anthropicLayer } from "@effect-uai/anthropic/Anthropic"
import { layer as cdpLayer } from "@effect-uai/browser/Connect"
import { layer as elevenLabsMusicLayer } from "@effect-uai/elevenlabs/ElevenLabsMusicGenerator"
import { layer as elevenLabsSynthLayer } from "@effect-uai/elevenlabs/ElevenLabsSynthesizer"
import { layer as elevenLabsTranscribeLayer } from "@effect-uai/elevenlabs/ElevenLabsTranscriber"
import { layer as exaContentsLayer } from "@effect-uai/exa/ExaContents"
import { layer as exaSearchLayer } from "@effect-uai/exa/ExaSearch"
import { layer as falImageLayer } from "@effect-uai/fal/FalImageGenerator"
import { layer as firecrawlReadLayer } from "@effect-uai/firecrawl/FirecrawlRead"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { layer as geminiEmbeddingLayer } from "@effect-uai/google/GeminiEmbedding"
import { layer as geminiImageLayer } from "@effect-uai/google/GeminiImageGenerator"
import { layer as geminiSynthLayer } from "@effect-uai/google/GeminiSynthesizer"
import { layer as googleResearchLayer } from "@effect-uai/google/GoogleDeepResearch"
import { layer as lyriaLayer } from "@effect-uai/google/LyriaGenerator"
import { layer as inworldRealtimeSynthLayer } from "@effect-uai/inworld/InworldRealtimeSynthesizer"
import { layer as inworldRealtimeTranscribeLayer } from "@effect-uai/inworld/InworldRealtimeTranscriber"
import { layer as inworldSynthLayer } from "@effect-uai/inworld/InworldSynthesizer"
import { layer as inworldTranscribeLayer } from "@effect-uai/inworld/InworldTranscriber"
import { type JinaEmbedding, layer as jinaEmbeddingLayer } from "@effect-uai/jina/JinaEmbedding"
import { layer as jinaReaderLayer } from "@effect-uai/jina/JinaReader"
import { layer as jinaRerankerLayer } from "@effect-uai/jina/JinaReranker"
import { layer as mistralLayer } from "@effect-uai/mistral/Mistral"
import { layer as mistralRealtimeTranscribeLayer } from "@effect-uai/mistral/MistralRealtimeTranscriber"
import { layer as mistralSynthLayer } from "@effect-uai/mistral/MistralSynthesizer"
import { layer as mistralTranscribeLayer } from "@effect-uai/mistral/MistralTranscriber"
import { layer as openaiImageLayer } from "@effect-uai/openai/OpenAIImageGenerator"
import { layer as openaiRealtimeTranscribeLayer } from "@effect-uai/openai/OpenAIRealtimeTranscriber"
import { layer as openaiSynthLayer } from "@effect-uai/openai/OpenAISynthesizer"
import { layer as openaiTranscribeLayer } from "@effect-uai/openai/OpenAITranscriber"
import { layer as perplexityResearchLayer } from "@effect-uai/perplexity/PerplexityDeepResearch"
import { layer as perplexitySearchLayer } from "@effect-uai/perplexity/PerplexitySearch"
import { layer as openaiEmbeddingLayer } from "@effect-uai/responses/OpenAIEmbedding"
import { layer as openaiResearchLayer } from "@effect-uai/responses/OpenAIDeepResearch"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { layer as tavilyReadLayer } from "@effect-uai/tavily/TavilyRead"
import { layer as tavilySearchLayer } from "@effect-uai/tavily/TavilySearch"
import type { Browser } from "@effect-uai/core/Browser"
import type { DeepResearch } from "@effect-uai/core/DeepResearch"
import type { EmbeddingModel } from "@effect-uai/core/EmbeddingModel"
import type { ImageGenerator, ImageStreaming } from "@effect-uai/core/ImageGenerator"
import type { LanguageModel } from "@effect-uai/core/LanguageModel"
import type { MusicGenerator } from "@effect-uai/core/MusicGenerator"
import type { Reranker } from "@effect-uai/core/Reranker"
import type {
  MultiSpeakerTts,
  SpeechSynthesizer,
  TtsIncrementalText,
} from "@effect-uai/core/SpeechSynthesizer"
import type { SttStreaming, Transcriber } from "@effect-uai/core/Transcriber"
import type { WebRead } from "@effect-uai/core/WebRead"
import type { WebSearch } from "@effect-uai/core/WebSearch"

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

/** `spec` is only what the user typed, echoed back when nothing matches. */
const lookup = <L>(
  spec: string,
  provider: string,
  baseUrl: string | undefined,
  entries: Record<string, Entry<L>>,
): Effect.Effect<L, Config.ConfigError | UnknownProvider> => {
  const entry = entries[provider]
  return entry === undefined
    ? Effect.fail(
        new UnknownProvider({ spec, provider, expected: Object.keys(entries).join(" | ") }),
      )
    : Effect.map(entry.apiKey, (apiKey) => entry.layer(apiKey, baseUrl))
}

const registry = <L>(
  spec: ModelSpec,
  baseUrl: string | undefined,
  entries: Record<string, Entry<L>>,
): Effect.Effect<L, Config.ConfigError | UnknownProvider> =>
  lookup(`${spec.provider}:${spec.model}`, spec.provider, baseUrl, entries)

/** For capabilities with no model of their own: the whole spec is the provider. */
const byProvider = <L>(
  provider: string,
  baseUrl: string | undefined,
  entries: Record<string, Entry<L>>,
): Effect.Effect<L, Config.ConfigError | UnknownProvider> =>
  lookup(provider, provider, baseUrl, entries)

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

type StreamingImageLayer = Layer.Layer<
  ImageGenerator | ImageStreaming,
  never,
  HttpClient.HttpClient
>

const imageEntries: Record<string, Entry<ImageLayer>> = {
  openai: {
    layer: (apiKey, baseUrl) => openaiImageLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("OPENAI_API_KEY"),
  },
  // OpenRouter is absent: its image API is `POST /api/v1/images` taking
  // `input_references`, not OpenAI's `/v1/images/generations` and
  // `/v1/images/edits`, so this adapter cannot reach it at any base URL.
  requesty: {
    layer: (apiKey, baseUrl) => openaiImageLayer({ apiKey, baseUrl: baseUrl ?? REQUESTY }),
    apiKey: key("REQUESTY_API_KEY", "LLM_API_KEY"),
  },
  google: {
    layer: (apiKey, baseUrl) => geminiImageLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("GOOGLE_API_KEY"),
  },
  // The model here is an endpoint path, so it carries slashes:
  // `--model fal:bytedance/seedream/v5/pro/text-to-image`.
  fal: {
    layer: (apiKey, baseUrl) => falImageLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("FAL_API_KEY"),
  },
}

/** `ImageGenerator` for one spec. The typed provider tag is registered too. */
export const imageGeneratorLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<ImageGenerator, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(registry(spec, baseUrl, imageEntries))

/**
 * The same, restricted to providers that emit partial images.
 *
 * Gemini has no partial-image wire. Requesty serves the image endpoints
 * but drops `stream` on the way through: a bare curl carrying both
 * `stream: true` and `partial_images: 1` still comes back "Partial images
 * are only supported with streaming" from the provider behind it
 * (reproduced 2026-09-05, no SDK involved). Registering either would
 * promise previews this Layer cannot deliver.
 */
const streamingImageEntries: Record<string, Entry<StreamingImageLayer>> = {
  openai: imageEntries.openai as Entry<StreamingImageLayer>,
}

/** Does this provider's adapter emit partial images? */
export const streamsPartialImages = (provider: string): boolean => provider in streamingImageEntries

export const streamingImageGeneratorLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<
  ImageGenerator | ImageStreaming,
  Config.ConfigError | UnknownProvider,
  HttpClient.HttpClient
> => Layer.unwrap(registry(spec, baseUrl, streamingImageEntries))

// ---------------------------------------------------------------------------
// Speech out
//
// Two marker tags separate what a synthesizer can do beyond one-shot audio:
// `TtsIncrementalText` for feeding it a text stream, `MultiSpeakerTts` for a
// dialogue with named speakers. A recipe that needs one asks for that Layer
// and gets a compile error from the providers that do not offer it.
// ---------------------------------------------------------------------------

/** ElevenLabs opens a socket for its incremental path, so every speech Layer takes one. */
type SpeechDeps = HttpClient.HttpClient | Socket.WebSocketConstructor

type SynthLayer = Layer.Layer<SpeechSynthesizer, never, SpeechDeps>
type IncrementalSynthLayer = Layer.Layer<SpeechSynthesizer | TtsIncrementalText, never, SpeechDeps>
type DialogueSynthLayer = Layer.Layer<SpeechSynthesizer | MultiSpeakerTts, never, SpeechDeps>

const synthEntries: Record<string, Entry<SynthLayer>> = {
  elevenlabs: {
    layer: (apiKey, baseUrl) => elevenLabsSynthLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("ELEVENLABS_API_KEY"),
  },
  openai: {
    layer: (apiKey, baseUrl) => openaiSynthLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("OPENAI_API_KEY"),
  },
  google: {
    layer: (apiKey, baseUrl) => geminiSynthLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("GOOGLE_API_KEY"),
  },
  inworld: {
    layer: (apiKey, baseUrl) => inworldSynthLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("INWORLD_API_KEY"),
  },
  mistral: {
    layer: (apiKey, baseUrl) => mistralSynthLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("MISTRAL_API_KEY"),
  },
}

/** `SpeechSynthesizer` for one spec. The typed provider tag is registered too. */
export const speechSynthesizerLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<SpeechSynthesizer, Config.ConfigError | UnknownProvider, SpeechDeps> =>
  Layer.unwrap(registry(spec, baseUrl, synthEntries))

/**
 * Synthesizers that take a `Stream<string>` in, so speech starts before the
 * model has finished writing. Inworld's incremental path is a different
 * endpoint from its one-shot one, hence the separate Layer.
 */
const incrementalSynthEntries: Record<string, Entry<IncrementalSynthLayer>> = {
  elevenlabs: synthEntries.elevenlabs as Entry<IncrementalSynthLayer>,
  mistral: synthEntries.mistral as Entry<IncrementalSynthLayer>,
  inworld: {
    layer: (apiKey, baseUrl) => inworldRealtimeSynthLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("INWORLD_API_KEY"),
  },
}

export const incrementalSynthesizerLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<
  SpeechSynthesizer | TtsIncrementalText,
  Config.ConfigError | UnknownProvider,
  SpeechDeps
> => Layer.unwrap(registry(spec, baseUrl, incrementalSynthEntries))

/** Named speakers in one call. Only ElevenLabs registers `MultiSpeakerTts`. */
const dialogueSynthEntries: Record<string, Entry<DialogueSynthLayer>> = {
  elevenlabs: synthEntries.elevenlabs as Entry<DialogueSynthLayer>,
}

export const dialogueSynthesizerLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<
  SpeechSynthesizer | MultiSpeakerTts,
  Config.ConfigError | UnknownProvider,
  SpeechDeps
> => Layer.unwrap(registry(spec, baseUrl, dialogueSynthEntries))

// ---------------------------------------------------------------------------
// Speech in
// ---------------------------------------------------------------------------

type TranscribeLayer = Layer.Layer<Transcriber, never, SpeechDeps>
type StreamingTranscribeLayer = Layer.Layer<Transcriber | SttStreaming, never, SpeechDeps>

const transcribeEntries: Record<string, Entry<TranscribeLayer>> = {
  openai: {
    layer: (apiKey, baseUrl) => openaiTranscribeLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("OPENAI_API_KEY"),
  },
  elevenlabs: {
    layer: (apiKey, baseUrl) => elevenLabsTranscribeLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("ELEVENLABS_API_KEY"),
  },
  inworld: {
    layer: (apiKey, baseUrl) => inworldTranscribeLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("INWORLD_API_KEY"),
  },
  mistral: {
    layer: (apiKey, baseUrl) => mistralTranscribeLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("MISTRAL_API_KEY"),
  },
}

/** `Transcriber` for one spec. The typed provider tag is registered too. */
export const transcriberLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<Transcriber, Config.ConfigError | UnknownProvider, SpeechDeps> =>
  Layer.unwrap(registry(spec, baseUrl, transcribeEntries))

/**
 * The same, restricted to providers that transcribe a live audio stream.
 * ElevenLabs serves both from one Layer; the other three keep the realtime
 * socket on a separate endpoint.
 */
const streamingTranscribeEntries: Record<string, Entry<StreamingTranscribeLayer>> = {
  elevenlabs: transcribeEntries.elevenlabs as Entry<StreamingTranscribeLayer>,
  openai: {
    layer: (apiKey, baseUrl) => openaiRealtimeTranscribeLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("OPENAI_API_KEY"),
  },
  inworld: {
    layer: (apiKey, baseUrl) => inworldRealtimeTranscribeLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("INWORLD_API_KEY"),
  },
  mistral: {
    layer: (apiKey, baseUrl) => mistralRealtimeTranscribeLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("MISTRAL_API_KEY"),
  },
}

export const streamingTranscriberLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<Transcriber | SttStreaming, Config.ConfigError | UnknownProvider, SpeechDeps> =>
  Layer.unwrap(registry(spec, baseUrl, streamingTranscribeEntries))

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

type MusicLayer = Layer.Layer<MusicGenerator, never, HttpClient.HttpClient>

const musicEntries: Record<string, Entry<MusicLayer>> = {
  elevenlabs: {
    layer: (apiKey, baseUrl) => elevenLabsMusicLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("ELEVENLABS_API_KEY"),
  },
  google: {
    layer: (apiKey, baseUrl) => lyriaLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("GOOGLE_API_KEY"),
  },
}

export const musicGeneratorLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<MusicGenerator, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(registry(spec, baseUrl, musicEntries))

// ---------------------------------------------------------------------------
// Embeddings and reranking
// ---------------------------------------------------------------------------

type EmbeddingLayer = Layer.Layer<EmbeddingModel, never, HttpClient.HttpClient>
type RerankLayer = Layer.Layer<Reranker, never, HttpClient.HttpClient>

const embeddingEntries: Record<string, Entry<EmbeddingLayer>> = {
  google: {
    layer: (apiKey, baseUrl) => geminiEmbeddingLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("GOOGLE_API_KEY"),
  },
  openai: {
    layer: (apiKey, baseUrl) => openaiEmbeddingLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("OPENAI_API_KEY"),
  },
  jina: {
    layer: (apiKey, baseUrl) => jinaEmbeddingLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("JINA_API_KEY"),
  },
}

export const embeddingModelLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<EmbeddingModel, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(registry(spec, baseUrl, embeddingEntries))

/**
 * The same, restricted to providers that return one vector per token rather
 * than one per input. Only Jina does, and `encoding: "multivector"` is its
 * own knob, so the typed tag comes along.
 */
type MultivectorLayer = Layer.Layer<EmbeddingModel | JinaEmbedding, never, HttpClient.HttpClient>

const multivectorEntries: Record<string, Entry<MultivectorLayer>> = {
  jina: embeddingEntries.jina as Entry<MultivectorLayer>,
}

export const multivectorEmbeddingLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<
  EmbeddingModel | JinaEmbedding,
  Config.ConfigError | UnknownProvider,
  HttpClient.HttpClient
> => Layer.unwrap(registry(spec, baseUrl, multivectorEntries))

const rerankEntries: Record<string, Entry<RerankLayer>> = {
  jina: {
    layer: (apiKey, baseUrl) => jinaRerankerLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("JINA_API_KEY"),
  },
}

export const rerankerLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<Reranker, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(registry(spec, baseUrl, rerankEntries))

// ---------------------------------------------------------------------------
// Deep research
// ---------------------------------------------------------------------------

type ResearchLayer = Layer.Layer<DeepResearch, never, HttpClient.HttpClient>

const researchEntries: Record<string, Entry<ResearchLayer>> = {
  openai: {
    layer: (apiKey, baseUrl) => openaiResearchLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("OPENAI_API_KEY"),
  },
  google: {
    layer: (apiKey, baseUrl) => googleResearchLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("GOOGLE_API_KEY"),
  },
  perplexity: {
    layer: (apiKey, baseUrl) => perplexityResearchLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("PERPLEXITY_API_KEY"),
  },
}

export const deepResearchLayer = (
  spec: ModelSpec,
  baseUrl?: string,
): Layer.Layer<DeepResearch, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(registry(spec, baseUrl, researchEntries))

// ---------------------------------------------------------------------------
// The web
//
// Neither capability takes a model, so the flag is a bare provider name.
// ---------------------------------------------------------------------------

type SearchLayer = Layer.Layer<WebSearch, never, HttpClient.HttpClient>
type ReadLayer = Layer.Layer<WebRead, never, HttpClient.HttpClient>

const searchEntries: Record<string, Entry<SearchLayer>> = {
  exa: {
    layer: (apiKey, baseUrl) => exaSearchLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("EXA_API_KEY"),
  },
  tavily: {
    layer: (apiKey, baseUrl) => tavilySearchLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("TAVILY_API_KEY"),
  },
  perplexity: {
    layer: (apiKey, baseUrl) => perplexitySearchLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("PERPLEXITY_API_KEY"),
  },
}

export const webSearchLayer = (
  provider: string,
  baseUrl?: string,
): Layer.Layer<WebSearch, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(byProvider(provider, baseUrl, searchEntries))

const readEntries: Record<string, Entry<ReadLayer>> = {
  firecrawl: {
    layer: (apiKey, baseUrl) => firecrawlReadLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("FIRECRAWL_API_KEY"),
  },
  jina: {
    layer: (apiKey, baseUrl) => jinaReaderLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("JINA_API_KEY"),
  },
  exa: {
    layer: (apiKey, baseUrl) => exaContentsLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("EXA_API_KEY"),
  },
  tavily: {
    layer: (apiKey, baseUrl) => tavilyReadLayer({ apiKey, ...at(baseUrl) }),
    apiKey: key("TAVILY_API_KEY"),
  },
}

export const webReadLayer = (
  provider: string,
  baseUrl?: string,
): Layer.Layer<WebRead, Config.ConfigError | UnknownProvider, HttpClient.HttpClient> =>
  Layer.unwrap(byProvider(provider, baseUrl, readEntries))

// ---------------------------------------------------------------------------
// Browser
//
// No key and no model: a CDP endpoint is the whole configuration. Start one
// with `docker run -d -p 127.0.0.1:9222:9222 chromedp/headless-shell`.
// ---------------------------------------------------------------------------

const VersionInfo = Schema.Struct({ webSocketDebuggerUrl: Schema.String })

/**
 * `ws://` passes through; `http://` is resolved via CDP's `/json/version`.
 * Only the path is taken from the response, so a port-remapped container
 * (whose Chrome reports its internal port) still resolves correctly.
 */
const resolveCdpEndpoint = (raw: string) =>
  raw.startsWith("http")
    ? Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const base = raw.replace(/\/$/, "")
        const response = yield* client.get(`${base}/json/version`)
        const info = yield* Schema.decodeUnknownEffect(VersionInfo)(yield* response.json)
        return `${base.replace(/^http/, "ws")}${new URL(info.webSocketDebuggerUrl).pathname}`
      })
    : Effect.succeed(raw)

export const browserLayer = (
  endpoint = "http://127.0.0.1:9222",
): Layer.Layer<Browser, unknown, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(resolveCdpEndpoint(endpoint), (endpoint) => cdpLayer({ endpoint })))
