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
import type { TurnDelta } from "@effect-uai/core/Turn"
import {
  type Accumulator,
  type GenerationConfig,
  WireChunk,
  accumulatorToTurn,
  buildRequestBody,
  emptyAccumulator,
  ingestChunk,
} from "./codec.js"
import type { GoogleModel } from "./models.js"

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
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: GeminiRequestOptions,
  ) => Stream.Stream<TurnDelta, AiError.AiError>
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

const sseEventToChunk = (ev: SSE.Event): Effect.Effect<Option.Option<WireChunk>, JsonParseError> =>
  Effect.try({
    try: () => JSON.parse(ev.data) as unknown,
    catch: (cause) => new JsonParseError({ line: ev.data, cause }),
  }).pipe(Effect.flatMap(decodeChunk), Effect.option)

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

const buildStream = (cfg: Config) => {
  const baseUrl = cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
  return (
    history: ReadonlyArray<Item>,
    options: Option.Option<GeminiRequestOptions>,
  ): Stream.Stream<TurnDelta, AiError.AiError, HttpClient.HttpClient> =>
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
          Stream.flatMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: Stream.succeed,
            }),
          ),
          Stream.mapAccum(
            (): Accumulator => emptyAccumulator,
            (acc, chunk) => {
              const result = ingestChunk(acc, chunk)
              const deltas: ReadonlyArray<TurnDelta> = [
                ...(result.chunkText.length > 0
                  ? [{ type: "text_delta" as const, text: result.chunkText }]
                  : []),
                ...(result.finished
                  ? [
                      {
                        type: "turn_complete" as const,
                        turn: accumulatorToTurn(result.accumulator),
                      },
                    ]
                  : []),
              ]
              return [result.accumulator, deltas] as const
            },
          ),
        )
      }),
    )
}

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
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    streamTurn: (history, options) =>
      buildStream(cfg)(history, Option.fromUndefinedOr(options)).pipe(
        Stream.provideService(HttpClient.HttpClient, client),
      ),
  }))

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
