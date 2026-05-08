import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import {
  type CommonRequest,
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

export type GeminiRequest = Omit<CommonRequest, "model"> & {
  /**
   * Narrows `CommonRequest.model` (`string`) to the typed `GoogleModel`
   * literal union for autocomplete.
   */
  readonly model: GoogleModel
  /**
   * Gemini 2.5 thinking budget. `0` disables thinking entirely (lowest
   * latency); higher values let the model think longer. Forwarded as
   * `generationConfig.thinkingConfig.thinkingBudget`.
   */
  readonly thinkingBudget?: number
}

export type GeminiService = {
  /**
   * Stream the provider's native event vocabulary (post-SSE-decode). For
   * Gemini, each event is a full `GenerateContentResponse` chunk. Use this
   * when you need access to fields the canonical view doesn't surface
   * (`thoughtSignature`, granular `safetyRatings`, etc.). For
   * provider-portable code, use `streamTurn`.
   */
  readonly streamNative: (request: GeminiRequest) => Stream.Stream<ProviderEvent, AiError.AiError>
  /**
   * Stream canonical `TurnEvent`s. Implemented as
   * `streamNative |> toCanonical`.
   */
  readonly streamTurn: (request: GeminiRequest) => Stream.Stream<TurnEvent, AiError.AiError>
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

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const buildGenerationConfig = (request: GeminiRequest): Option.Option<GenerationConfig> => {
  const cfg: GenerationConfig = {
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.maxOutputTokens !== undefined && { maxOutputTokens: request.maxOutputTokens }),
    ...(request.topP !== undefined && { topP: request.topP }),
    ...(request.thinkingBudget !== undefined && {
      thinkingConfig: { thinkingBudget: request.thinkingBudget },
    }),
    ...(request.structured !== undefined && {
      responseMimeType: "application/json",
      responseJsonSchema: request.structured.schema["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      }),
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
    request: GeminiRequest,
  ): Stream.Stream<ProviderEvent, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const url = `${baseUrl}/models/${request.model}:streamGenerateContent?alt=sse`
        const generationConfig = buildGenerationConfig(request)
        const body = buildRequestBody(request.history, generationConfig)
        const httpRequest = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
          HttpClientRequest.bodyJsonUnsafe(body),
          HttpClientRequest.accept("text/event-stream"),
        )
        const response = yield* client
          .execute(httpRequest)
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
 * Build a `GeminiService` value. For Layer-based setup, prefer `layer`.
 */
export const make = (cfg: Config): Effect.Effect<GeminiService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => {
    const streamNative: GeminiService["streamNative"] = (request) =>
      buildNativeStream(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client))
    return {
      streamNative,
      streamTurn: (request) => toCanonical(streamNative(request)),
      toCanonical,
    }
  })

/**
 * Layer that registers both the provider-specific `Gemini` tag and the
 * generic `LanguageModel` tag, sharing one underlying implementation.
 *
 * The generic tag accepts `CommonRequest`; the typed tag accepts the full
 * `GeminiRequest` surface.
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
        streamTurn: (request) => s.streamTurn(request as GeminiRequest),
      }),
    ),
  )
  return Layer.merge(typed, generic)
}
