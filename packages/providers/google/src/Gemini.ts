import { Context, Effect, Layer, Option, Redacted, Schema, Stream, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { Item } from "@effect-uai/core/Items"
import {
  type CommonRequestOptions,
  LanguageModel,
  type LanguageModelService,
} from "@effect-uai/core/LanguageModel"
import { JsonParseError } from "@effect-uai/core/JSONL"
import * as SSE from "@effect-uai/core/SSE"
import type { TurnEvent } from "@effect-uai/core/Turn"
import {
  type GenerationConfig,
  WireChunk,
  accumulatorToTurn,
  buildRequestBody,
  emptyAccumulator,
  ingestChunk,
} from "./codec.js"
import type { GoogleModel } from "./models.js"

/**
 * Gemini's native event vocabulary. Aliased from `WireChunk` so the public
 * surface matches `@effect-uai/responses` and `@effect-uai/anthropic`. Each
 * `ProviderEvent` is a full `GenerateContentResponse` chunk (not a per-field
 * delta) - that's how Gemini's SSE works.
 */
export const ProviderEvent = WireChunk
export type ProviderEvent = WireChunk

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeminiRequestOptions extends CommonRequestOptions {
  /**
   * Gemini 2.5 thinking budget. `0` disables thinking entirely (lowest
   * latency); higher values let the model think longer. Forwarded as
   * `generationConfig.thinkingConfig.thinkingBudget`.
   */
  readonly thinkingBudget?: number
}

export interface GeminiService {
  /**
   * Stream the provider's native event vocabulary (post-SSE-decode). For
   * Gemini, each event is a full `GenerateContentResponse` chunk. Use this
   * when you need access to fields the canonical view doesn't surface
   * (`thoughtSignature`, granular `safetyRatings`, etc.). For
   * provider-portable code, use `streamTurn`.
   */
  readonly streamNative: (
    history: ReadonlyArray<Item>,
    options?: GeminiRequestOptions,
  ) => Stream.Stream<ProviderEvent, AiError.AiError>
  /**
   * Stream canonical `TurnEvent`s. Implemented as
   * `streamNative |> toCanonical`.
   */
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: GeminiRequestOptions,
  ) => Stream.Stream<TurnEvent, AiError.AiError>
  /**
   * Project a stream of native `ProviderEvent`s into canonical `TurnEvent`s.
   * Threads a fresh `Accumulator` so chunk-level text/usage merging happens
   * per stream.
   */
  readonly toCanonical: <E, R>(
    s: Stream.Stream<ProviderEvent, E, R>,
  ) => Stream.Stream<TurnEvent, E, R>
}

/**
 * Provider-typed service tag. Yield this when you want Gemini-specific
 * options (`thinkingBudget`); yield the generic `LanguageModel` tag for
 * provider-portable code. Both are registered by `layer`.
 */
export class Gemini extends Context.Service<Gemini, GeminiService>()(
  "@betalyra/effect-uai/providers/google/Gemini",
) {}

export interface Config {
  readonly apiKey: Redacted.Redacted
  readonly model: GoogleModel
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const buildGenerationConfig = (options: GeminiRequestOptions): Option.Option<GenerationConfig> => {
  const cfg: GenerationConfig = {
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.maxOutputTokens !== undefined && { maxOutputTokens: options.maxOutputTokens }),
    ...(options.topP !== undefined && { topP: options.topP }),
    ...(options.thinkingBudget !== undefined && {
      thinkingConfig: { thinkingBudget: options.thinkingBudget },
    }),
  }
  return Object.keys(cfg).length === 0 ? Option.none() : Option.some(cfg)
}

// ---------------------------------------------------------------------------
// SSE event → wire chunk
// ---------------------------------------------------------------------------

const decodeChunk = Schema.decodeUnknownEffect(WireChunk)

/**
 * Parse one SSE event's `data` payload into a `WireChunk`. Unlike the other
 * providers, Gemini's wire vocabulary is non-discriminated (a single
 * permissive struct, all fields optional) - there's no natural shape for
 * an `_unknown` variant, so JSON parse / schema decode failures flow
 * through as transport errors rather than being silently dropped.
 */
const sseEventToChunk = (ev: SSE.Event) =>
  Effect.try({
    try: () => JSON.parse(ev.data) as unknown,
    catch: (cause) => new JsonParseError({ line: ev.data, cause }),
  }).pipe(Effect.flatMap(decodeChunk))

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "gemini"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status === 413) return new AiError.ContextLengthExceeded({ provider, raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

const buildNativeStream = (cfg: Config) => {
  const baseUrl = cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
  return (
    history: ReadonlyArray<Item>,
    options: Option.Option<GeminiRequestOptions>,
  ): Stream.Stream<ProviderEvent, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const url = `${baseUrl}/models/${cfg.model}:streamGenerateContent?alt=sse`
        const generationConfig = pipe(options, Option.flatMap(buildGenerationConfig))
        const body = buildRequestBody(history, generationConfig)
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
          HttpClientRequest.bodyJsonUnsafe(body),
          HttpClientRequest.accept("text/event-stream"),
        )
        const response = yield* client
          .execute(request)
          .pipe(
            Effect.mapError(
              (cause): AiError.AiError =>
                new AiError.Unavailable({ provider: "gemini", raw: cause }),
            ),
          )
        if (response.status >= 400) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return Stream.fail(httpStatusError(response.status, text))
        }

        return response.stream.pipe(
          Stream.mapError(
            (cause): AiError.AiError => new AiError.Unavailable({ provider: "gemini", raw: cause }),
          ),
          SSE.fromBytes,
          Stream.mapEffect((ev) =>
            sseEventToChunk(ev).pipe(
              Effect.mapError(
                (cause): AiError.AiError =>
                  new AiError.Unavailable({ provider: "gemini", raw: cause }),
              ),
            ),
          ),
        )
      }),
    )
}

/**
 * Project a stream of native `ProviderEvent`s into canonical `TurnEvent`s.
 * Threads a fresh `Accumulator` so chunk-level text/usage merging works
 * across the run.
 */
export const toCanonical = <E, R>(
  s: Stream.Stream<ProviderEvent, E, R>,
): Stream.Stream<TurnEvent, E, R> =>
  s.pipe(
    Stream.mapAccum(
      () => emptyAccumulator,
      (acc, chunk) => {
        const result = ingestChunk(acc, chunk)
        const partDeltas = result.parts.map((p) =>
          p.kind === "text"
            ? { type: "text_delta" as const, text: p.text }
            : { type: "reasoning_delta" as const, text: p.text, kind: "trace" as const },
        )
        const deltas = result.finished
          ? [
              ...partDeltas,
              {
                type: "turn_complete" as const,
                turn: accumulatorToTurn(result.accumulator),
              },
            ]
          : partDeltas
        return [result.accumulator, deltas] as const
      },
    ),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `GeminiService` value scoped to one model + http client. Use
 * this when you want to swap models per iteration via
 * `Effect.provideService(Gemini, model)`. For Layer-based setup, prefer
 * `layer`.
 */
export const make = (cfg: Config): Effect.Effect<GeminiService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => {
    const streamNative: GeminiService["streamNative"] = (history, options) =>
      buildNativeStream(cfg)(history, Option.fromUndefinedOr(options)).pipe(
        Stream.provideService(HttpClient.HttpClient, client),
      )
    return {
      streamNative,
      streamTurn: (history, options) => toCanonical(streamNative(history, options)),
      toCanonical,
    }
  })

/**
 * Layer that registers both the provider-specific `Gemini` tag and the
 * generic `LanguageModel` tag, sharing one underlying implementation.
 *
 * The generic tag accepts only `CommonRequestOptions`; the typed tag
 * accepts the full `GeminiRequestOptions` surface.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<Gemini | LanguageModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(Gemini, make(cfg))
  const generic = Layer.effect(
    LanguageModel,
    Effect.map(
      make(cfg),
      (s): LanguageModelService => ({
        streamTurn: (history, options) => s.streamTurn(history, options),
      }),
    ),
  )
  return Layer.merge(typed, generic)
}
