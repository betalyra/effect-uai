import { Effect, Layer, Option, Redacted, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import {
  type CommonRequest,
  LanguageModel,
  type LanguageModelService,
  turnFromStream,
} from "@effect-uai/core/LanguageModel"
import * as SSE from "@effect-uai/core/SSE"
import { descriptorsOf } from "@effect-uai/core/Tool"
import { TurnEvent } from "@effect-uai/core/Turn"
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
import { httpStatusError, transportFailure } from "./http.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type ChatConfig = {
  readonly apiKey: Redacted.Redacted
  /** Provider base URL, e.g. `https://openrouter.ai/api/v1`. No trailing slash. */
  readonly baseUrl: string
  /** Name used to tag `AiError`s from this provider. */
  readonly provider: string
  /** Request path appended to `baseUrl`. Defaults to `/chat/completions`. */
  readonly path?: string
  /**
   * Override the auth header. Defaults to `Authorization: Bearer <apiKey>`.
   * Supply this for gateways that authenticate differently (e.g. Azure `api-key`).
   */
  readonly authHeader?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest
  /** Extra headers merged into every request (e.g. OpenRouter `HTTP-Referer`). */
  readonly extraHeaders?: Record<string, string>
  /** Provider-specific request-body fields merged into the wire body. */
  readonly extraBody?: (request: CommonRequest) => Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const buildRequestBody = (cfg: ChatConfig, request: CommonRequest): Record<string, unknown> => {
  const tools = toolsWire(descriptorsOf(request.tools))
  return {
    model: request.model,
    stream: true,
    messages: itemsToMessages(request.history),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.topP !== undefined && { top_p: request.topP }),
    ...(request.maxOutputTokens !== undefined && { max_tokens: request.maxOutputTokens }),
    ...(Option.isSome(tools) && { tools: tools.value }),
    ...(request.toolChoice !== undefined && { tool_choice: toolChoiceWire(request.toolChoice) }),
    ...(request.structured !== undefined && {
      response_format: responseFormatWire(request.structured),
    }),
    ...(cfg.extraBody?.(request) ?? {}),
  }
}

// ---------------------------------------------------------------------------
// SSE → WireChunk
// ---------------------------------------------------------------------------

const parseJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/**
 * Decode one SSE event's `data` payload into a `WireChunk`. Returns `None` for
 * the `[DONE]` sentinel and for any payload that isn't a chunk we model, so a
 * stray keep-alive never aborts the turn.
 */
const decodeEvent = (data: string): Effect.Effect<Option.Option<WireChunk>> =>
  data.trim() === "[DONE]"
    ? Effect.succeedNone
    : parseJsonUnknown(data).pipe(Effect.flatMap(decodeChunk), Effect.option)

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

const buildStream = (cfg: ChatConfig) => {
  const url = `${cfg.baseUrl}${cfg.path ?? "/chat/completions"}`
  const auth = cfg.authHeader ?? HttpClientRequest.bearerToken(cfg.apiKey)
  return (
    request: CommonRequest,
  ): Stream.Stream<TurnEvent, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* Capabilities.warnDroppedBlocks(request.history, "output_image", {
          provider: cfg.provider,
          capability: "output_image",
          reason:
            "Assistant messages carry no image on this wire. Use `Turn.imagesAsInput` to resend it as user content.",
        })
        const httpRequest = HttpClientRequest.post(url).pipe(
          auth,
          HttpClientRequest.setHeaders(cfg.extraHeaders ?? {}),
          HttpClientRequest.bodyJsonUnsafe(buildRequestBody(cfg, request)),
          HttpClientRequest.accept("text/event-stream"),
        )
        const response = yield* client
          .execute(httpRequest)
          .pipe(Effect.mapError((cause) => transportFailure(cfg.provider, cause)))
        if (response.status >= 400) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return Stream.fail(httpStatusError(cfg.provider, response.status, text))
        }

        return response.stream.pipe(
          Stream.mapError(
            (cause): AiError.AiError =>
              new AiError.Unavailable({ provider: cfg.provider, raw: cause }),
          ),
          SSE.fromBytes,
          Stream.mapEffect((ev) => decodeEvent(ev.data)),
          Stream.filterMap((chunk) =>
            Option.isSome(chunk) ? Result.succeed(chunk.value) : Result.failVoid,
          ),
          Stream.mapAccum((): Accumulator => emptyAccumulator, applyChunk, {
            // `onHalt` also fires on upstream failure and truncated streams, so
            // only emit `TurnComplete` once a `finish_reason` was observed.
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

/** Build a generic chat-completions `LanguageModelService`. */
export const make = (
  cfg: ChatConfig,
): Effect.Effect<LanguageModelService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => {
    const streamTurn: LanguageModelService["streamTurn"] = (request) =>
      buildStream(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client))
    return {
      streamTurn,
      turn: turnFromStream(streamTurn),
    }
  })

/** Layer registering the generic `LanguageModel` tag for a compatible gateway. */
export const layer = (cfg: ChatConfig): Layer.Layer<LanguageModel, never, HttpClient.HttpClient> =>
  Layer.effect(LanguageModel, make(cfg))
