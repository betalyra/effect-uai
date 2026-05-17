import { Context, Effect, Layer, Match, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import {
  type CommonRequest,
  LanguageModel,
  type LanguageModelService,
  turnFromStream,
} from "@effect-uai/core/LanguageModel"
import * as SSE from "@effect-uai/core/SSE"
import type { Turn, TurnEvent } from "@effect-uai/core/Turn"
import { itemsToInput } from "./codec.js"
import type { OpenAIModel } from "./models.js"
import {
  KnownProviderEvent,
  ProviderEvent,
  eventToDeltas,
  makeCallIdLookup,
} from "./streamEvents.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResponsesRequest = Omit<CommonRequest, "model"> & {
  /**
   * Narrows `CommonRequest.model` (`string`) to the typed `OpenAIModel`
   * literal union for autocomplete.
   */
  readonly model: OpenAIModel
  readonly reasoning?: { readonly effort: "low" | "medium" | "high" }
  readonly store?: boolean
  readonly previousResponseId?: string
  readonly instructions?: string
  readonly parallelToolCalls?: boolean
  readonly metadata?: Readonly<Record<string, string>>
  readonly user?: string
  readonly safetyIdentifier?: string
  readonly promptCacheKey?: string
  readonly truncation?: "auto" | "disabled"
  /**
   * Free-form JSON output: model emits valid JSON without schema
   * constraints. Mutually exclusive with `structured` (schema wins if
   * both are set).
   */
  readonly responseFormat?: { readonly type: "json_object" }
  /**
   * Answer length / level-of-detail hint. GPT-5+ models honour it;
   * earlier models ignore.
   */
  readonly verbosity?: "low" | "medium" | "high"
}

export type ResponsesService = {
  /**
   * Stream the provider's native event vocabulary (post-SSE-decode).
   * Use this when you need full vendor fidelity. For provider-portable
   * code, use `streamTurn` instead.
   */
  readonly streamNative: (
    request: ResponsesRequest,
  ) => Stream.Stream<ProviderEvent, AiError.AiError>
  /**
   * Stream canonical `TurnEvent`s. Implemented as
   * `streamNative |> toCanonical`.
   */
  readonly streamTurn: (request: ResponsesRequest) => Stream.Stream<TurnEvent, AiError.AiError>
  /**
   * Drain a single turn and return the assembled `Turn`. Derived from
   * `streamTurn` — Responses doesn't expose a native non-streaming
   * complete endpoint we'd want to take advantage of.
   */
  readonly turn: (request: ResponsesRequest) => Effect.Effect<Turn, AiError.AiError>
  /**
   * Project a stream of native `ProviderEvent`s into canonical `TurnEvent`s.
   * Exposed for cases where consumers want to compose with `streamNative`
   * directly (e.g. tap into natives + still get canonical downstream).
   */
  readonly toCanonical: <E, R>(
    s: Stream.Stream<ProviderEvent, E, R>,
  ) => Stream.Stream<TurnEvent, E, R>
}

/**
 * Provider-typed service tag. Yield this when you want Responses-specific
 * options (`reasoning.effort`, `store`, `previousResponseId`) at the call
 * site. Yield the generic `LanguageModel` tag for provider-portable code -
 * both are registered by `layer`.
 */
export class Responses extends Context.Service<Responses, ResponsesService>()(
  "@betalyra/effect-uai/providers/responses/Responses",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const jsonSchemaFormat = (
  format: StructuredFormat.StructuredFormat<unknown>,
): Record<string, unknown> => ({
  type: "json_schema",
  name: format.name,
  schema: format.schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  ...(format.description !== undefined && { description: format.description }),
  ...(format.strict !== undefined && { strict: format.strict }),
})

const buildText = (request: ResponsesRequest): Record<string, unknown> | undefined => {
  const format =
    request.structured !== undefined ? jsonSchemaFormat(request.structured) : request.responseFormat
  const text: Record<string, unknown> = {}
  if (format !== undefined) text.format = format
  if (request.verbosity !== undefined) text.verbosity = request.verbosity
  return Object.keys(text).length === 0 ? undefined : text
}

const buildBody = (request: ResponsesRequest): Record<string, unknown> => {
  const text = buildText(request)
  return {
    model: request.model,
    input: itemsToInput(request.history),
    stream: true,
    ...(request.tools !== undefined &&
      request.tools.length > 0 && {
        tools: request.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
          ...(t.strict !== undefined && { strict: t.strict }),
        })),
      }),
    ...(request.toolChoice !== undefined && { tool_choice: request.toolChoice }),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.maxOutputTokens !== undefined && {
      max_output_tokens: request.maxOutputTokens,
    }),
    ...(request.reasoning !== undefined && { reasoning: request.reasoning }),
    ...(request.store !== undefined && { store: request.store }),
    ...(request.previousResponseId !== undefined && {
      previous_response_id: request.previousResponseId,
    }),
    ...(request.instructions !== undefined && { instructions: request.instructions }),
    ...(request.topP !== undefined && { top_p: request.topP }),
    ...(request.parallelToolCalls !== undefined && {
      parallel_tool_calls: request.parallelToolCalls,
    }),
    ...(request.metadata !== undefined && { metadata: request.metadata }),
    ...(request.user !== undefined && { user: request.user }),
    ...(request.safetyIdentifier !== undefined && {
      safety_identifier: request.safetyIdentifier,
    }),
    ...(request.promptCacheKey !== undefined && {
      prompt_cache_key: request.promptCacheKey,
    }),
    ...(request.truncation !== undefined && { truncation: request.truncation }),
    ...(text !== undefined && { text }),
  }
}

// ---------------------------------------------------------------------------
// SSE event → provider event
// ---------------------------------------------------------------------------

const decodeKnown = Schema.decodeUnknownEffect(KnownProviderEvent)

const makeUnknown = (raw: unknown): ProviderEvent => ({ type: "_unknown", raw })

/**
 * Lift events that carry a terminal failure signal (`error`,
 * `response.failed`) to a typed `AiError`. Other events are not failures
 * and produce `Option.none`.
 */
const eventToError = Match.type<ProviderEvent>().pipe(
  Match.discriminators("type")({
    error: (e): AiError.AiError => new AiError.Unavailable({ provider: "responses", raw: e }),
    "response.failed": (e): AiError.AiError => {
      const code = e.response.error?.code
      const message = e.response.error?.message
      return new AiError.GenerationFailed({
        provider: "responses",
        ...(code !== undefined && code !== null && { code }),
        ...(message !== undefined && message !== null && { message }),
        raw: e,
      })
    },
  }),
  Match.option,
)

const parseJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const sseEventToProviderEvent = (ev: SSE.Event): Effect.Effect<ProviderEvent> =>
  parseJsonUnknown(ev.data).pipe(
    Effect.flatMap((parsed) =>
      decodeKnown(parsed).pipe(Effect.orElseSucceed(() => makeUnknown(parsed))),
    ),
    Effect.orElseSucceed(() => makeUnknown(ev.data)),
  )

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "responses"
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
  const url = `${cfg.baseUrl ?? "https://api.openai.com/v1"}/responses`
  return (
    request: ResponsesRequest,
  ): Stream.Stream<ProviderEvent, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const httpRequest = HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(cfg.apiKey),
          HttpClientRequest.bodyJsonUnsafe(buildBody(request)),
          HttpClientRequest.accept("text/event-stream"),
        )
        const response = yield* client
          .execute(httpRequest)
          .pipe(
            Effect.mapError(
              (cause) => new AiError.Unavailable({ provider: "responses", raw: cause }),
            ),
          )
        if (response.status >= 400) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return Stream.fail(httpStatusError(response.status, body))
        }

        return response.stream.pipe(
          Stream.mapError(
            (cause) => new AiError.Unavailable({ provider: "responses", raw: cause }),
          ),
          SSE.fromBytes,
          Stream.mapEffect(sseEventToProviderEvent),
          Stream.flatMap((event) =>
            Option.match(eventToError(event), {
              onNone: () => Stream.succeed(event),
              onSome: Stream.fail,
            }),
          ),
        )
      }),
    )
}

/**
 * Project a stream of native `ProviderEvent`s into canonical `TurnEvent`s.
 * Threads a fresh `CallIdLookup` per stream so `function_call_arguments.delta`
 * can be tagged with the right `call_id`.
 */
export const toCanonical = <E, R>(
  s: Stream.Stream<ProviderEvent, E, R>,
): Stream.Stream<TurnEvent, E, R> =>
  Stream.unwrap(
    Effect.sync(() => {
      const lookup = makeCallIdLookup()
      return s.pipe(Stream.flatMap((event) => Stream.fromIterable(eventToDeltas(event, lookup))))
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `ResponsesService` value. For Layer-based setup, prefer `layer`.
 */
export const make = (cfg: Config): Effect.Effect<ResponsesService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => {
    const streamNative: ResponsesService["streamNative"] = (request) =>
      buildNativeStream(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client))
    const streamTurn: ResponsesService["streamTurn"] = (request) =>
      toCanonical(streamNative(request))
    return {
      streamNative,
      streamTurn,
      turn: turnFromStream(streamTurn),
      toCanonical,
    }
  })

/**
 * Layer that registers both the provider-specific `Responses` tag and the
 * generic `LanguageModel` tag, sharing one underlying implementation.
 *
 * The generic tag accepts `CommonRequest`; the typed tag accepts the full
 * `ResponsesRequest` surface.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<Responses | LanguageModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(Responses, make(cfg))
  const generic = Layer.effect(
    LanguageModel,
    Effect.map(
      make(cfg),
      (s): LanguageModelService => ({
        streamTurn: (request) => s.streamTurn(request as ResponsesRequest),
        turn: (request) => s.turn(request as ResponsesRequest),
      }),
    ),
  )
  return Layer.merge(typed, generic)
}
