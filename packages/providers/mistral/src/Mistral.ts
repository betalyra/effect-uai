import { Context, Effect, Layer, Option, Redacted, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import {
  type CommonRequest,
  LanguageModel,
  type LanguageModelService,
  turnFromStream,
} from "@effect-uai/core/LanguageModel"
import * as SSE from "@effect-uai/core/SSE"
import { descriptorsOf } from "@effect-uai/core/Tool"
import { type Turn, TurnEvent } from "@effect-uai/core/Turn"
import {
  type Accumulator,
  type WireChunk,
  accumulatorToTurn,
  applyChunk,
  decodeChunk,
  emptyAccumulator,
  itemsToMessages,
  responseFormatWire,
  toolChoiceWire,
  toolsWire,
} from "./codec.js"
import { httpStatusError } from "./http.js"
import type { MistralModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MistralRequest = Omit<CommonRequest, "model"> & {
  /**
   * Narrows `CommonRequest.model` (`string`) to the typed `MistralModel`
   * literal union for autocomplete.
   */
  readonly model: MistralModel
  /**
   * Prepend a safety system prompt (`safe_prompt` on the wire). Off by default.
   */
  readonly safePrompt?: boolean
  /** Deterministic sampling seed (`random_seed` on the wire). */
  readonly randomSeed?: number
}

export type MistralService = {
  /** Stream canonical `TurnEvent`s for one turn. */
  readonly streamTurn: (request: MistralRequest) => Stream.Stream<TurnEvent, AiError.AiError>
  /** Drain a single turn and return the assembled `Turn`. */
  readonly turn: (request: MistralRequest) => Effect.Effect<Turn, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this when you want Mistral-specific options
 * (`safePrompt`, `randomSeed`); yield the generic `LanguageModel` tag for
 * provider-portable code. Both are registered by `layer`.
 */
export class Mistral extends Context.Service<Mistral, MistralService>()(
  "@betalyra/effect-uai/providers/mistral/Mistral",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const buildRequestBody = (request: MistralRequest): Record<string, unknown> => {
  const tools = toolsWire(descriptorsOf(request.tools))
  return {
    model: request.model,
    stream: true,
    messages: itemsToMessages(request.history),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.topP !== undefined && { top_p: request.topP }),
    ...(request.maxOutputTokens !== undefined && { max_tokens: request.maxOutputTokens }),
    ...(request.safePrompt !== undefined && { safe_prompt: request.safePrompt }),
    ...(request.randomSeed !== undefined && { random_seed: request.randomSeed }),
    ...(Option.isSome(tools) && { tools: tools.value }),
    ...(request.toolChoice !== undefined && { tool_choice: toolChoiceWire(request.toolChoice) }),
    ...(request.structured !== undefined && {
      response_format: responseFormatWire(request.structured),
    }),
  }
}

// ---------------------------------------------------------------------------
// SSE → WireChunk
// ---------------------------------------------------------------------------

const parseJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/**
 * Decode one SSE event's `data` payload into a `WireChunk`. Returns `None`
 * for the `[DONE]` sentinel and for any payload that isn't a chunk we model,
 * so a stray keep-alive never aborts the turn.
 */
const decodeEvent = (data: string): Effect.Effect<Option.Option<WireChunk>> =>
  data.trim() === "[DONE]"
    ? Effect.succeedNone
    : parseJsonUnknown(data).pipe(Effect.flatMap(decodeChunk), Effect.option)

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

const buildStream = (cfg: Config) => {
  const baseUrl = cfg.baseUrl ?? "https://api.mistral.ai"
  const url = `${baseUrl}/v1/chat/completions`
  return (
    request: MistralRequest,
  ): Stream.Stream<TurnEvent, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const httpRequest = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(cfg.apiKey)}`),
          HttpClientRequest.bodyJsonUnsafe(buildRequestBody(request)),
          HttpClientRequest.accept("text/event-stream"),
        )
        const response = yield* client
          .execute(httpRequest)
          .pipe(
            Effect.mapError(
              (cause): AiError.AiError =>
                new AiError.Unavailable({ provider: "mistral", raw: cause }),
            ),
          )
        if (response.status >= 400) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return Stream.fail(httpStatusError(response.status, text))
        }

        return response.stream.pipe(
          Stream.mapError(
            (cause): AiError.AiError =>
              new AiError.Unavailable({ provider: "mistral", raw: cause }),
          ),
          SSE.fromBytes,
          Stream.mapEffect((ev) => decodeEvent(ev.data)),
          Stream.filterMap((chunk) =>
            Option.isSome(chunk) ? Result.succeed(chunk.value) : Result.failVoid,
          ),
          Stream.mapAccum((): Accumulator => emptyAccumulator, applyChunk, {
            // `onHalt` also fires on upstream failure and truncated streams,
            // so only emit `TurnComplete` once a `finish_reason` was observed
            onHalt: (acc) =>
              Option.isSome(acc.finishReason)
                ? [TurnEvent.TurnComplete({ turn: accumulatorToTurn(acc) })]
                : [],
          }),
        )
      }),
    )
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Build a `MistralService` value. For Layer-based setup, prefer `layer`. */
export const make = (cfg: Config): Effect.Effect<MistralService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => {
    const streamTurn: MistralService["streamTurn"] = (request) =>
      buildStream(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client))
    return {
      streamTurn,
      turn: turnFromStream(streamTurn),
    }
  })

/**
 * Layer that registers both the provider-specific `Mistral` tag and the
 * generic `LanguageModel` tag, sharing one underlying implementation.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<Mistral | LanguageModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(Mistral, make(cfg))
  const generic = Layer.effect(
    LanguageModel,
    Effect.map(make(cfg), (s): LanguageModelService => ({
      streamTurn: (request) => s.streamTurn(request as MistralRequest),
      turn: (request) => s.turn(request as MistralRequest),
    })),
  )
  return Layer.merge(typed, generic)
}
