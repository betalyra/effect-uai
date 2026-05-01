import { Context, Effect, Layer, Match, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { Item } from "@effect-uai/core/Items"
import { matchType } from "@effect-uai/core/Match"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import {
  type CommonRequestOptions,
  LanguageModel,
  type LanguageModelService,
} from "@effect-uai/core/LanguageModel"
import * as SSE from "@effect-uai/core/SSE"
import type { TurnEvent } from "@effect-uai/core/Turn"
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

export interface ResponsesRequestOptions extends CommonRequestOptions {
  readonly reasoning?: { readonly effort: "low" | "medium" | "high" }
  readonly store?: boolean
  readonly previousResponseId?: string
  readonly instructions?: string
  readonly topP?: number
  readonly parallelToolCalls?: boolean
  readonly metadata?: Readonly<Record<string, string>>
  readonly user?: string
  readonly safetyIdentifier?: string
  readonly promptCacheKey?: string
  readonly truncation?: "auto" | "disabled"
  /**
   * Schema-bound JSON output. The model's output is constrained to
   * match the format's JSON Schema. Pair with `Turn.toStructured` (or a
   * line-accumulation recipe) on the consumer side for runtime
   * validation.
   */
  readonly structured?: StructuredFormat.StructuredFormat<unknown>
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

export interface ResponsesService {
  /**
   * Stream the provider's native event vocabulary (post-SSE-decode).
   * Use this when you need full vendor fidelity. For provider-portable
   * code, use `streamTurn` instead.
   */
  readonly streamNative: (
    history: ReadonlyArray<Item>,
    options?: ResponsesRequestOptions,
  ) => Stream.Stream<ProviderEvent, AiError.AiError>
  /**
   * Stream canonical `TurnEvent`s. Implemented as
   * `streamNative |> toCanonical`.
   */
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: ResponsesRequestOptions,
  ) => Stream.Stream<TurnEvent, AiError.AiError>
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

export interface Config {
  readonly apiKey: Redacted.Redacted
  readonly model: OpenAIModel
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

const buildText = (
  options: ResponsesRequestOptions | undefined,
): Record<string, unknown> | undefined => {
  if (options === undefined) return undefined
  const format =
    options.structured !== undefined
      ? jsonSchemaFormat(options.structured)
      : options.responseFormat
  const text: Record<string, unknown> = {}
  if (format !== undefined) text.format = format
  if (options.verbosity !== undefined) text.verbosity = options.verbosity
  return Object.keys(text).length === 0 ? undefined : text
}

const buildBody = (
  history: ReadonlyArray<Item>,
  model: string,
  options: ResponsesRequestOptions | undefined,
): Record<string, unknown> => {
  const text = buildText(options)
  return {
    model,
    input: itemsToInput(history),
    stream: true,
    ...(options?.tools !== undefined &&
      options.tools.length > 0 && {
        tools: options.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
          ...(t.strict !== undefined && { strict: t.strict }),
        })),
      }),
    ...(options?.toolChoice !== undefined && { tool_choice: options.toolChoice }),
    ...(options?.temperature !== undefined && {
      temperature: options.temperature,
    }),
    ...(options?.maxOutputTokens !== undefined && {
      max_output_tokens: options.maxOutputTokens,
    }),
    ...(options?.reasoning !== undefined && { reasoning: options.reasoning }),
    ...(options?.store !== undefined && { store: options.store }),
    ...(options?.previousResponseId !== undefined && {
      previous_response_id: options.previousResponseId,
    }),
    ...(options?.instructions !== undefined && { instructions: options.instructions }),
    ...(options?.topP !== undefined && { top_p: options.topP }),
    ...(options?.parallelToolCalls !== undefined && {
      parallel_tool_calls: options.parallelToolCalls,
    }),
    ...(options?.metadata !== undefined && { metadata: options.metadata }),
    ...(options?.user !== undefined && { user: options.user }),
    ...(options?.safetyIdentifier !== undefined && {
      safety_identifier: options.safetyIdentifier,
    }),
    ...(options?.promptCacheKey !== undefined && {
      prompt_cache_key: options.promptCacheKey,
    }),
    ...(options?.truncation !== undefined && { truncation: options.truncation }),
    ...(text !== undefined && { text }),
  }
}

// ---------------------------------------------------------------------------
// SSE event → provider event
// ---------------------------------------------------------------------------

const decodeKnown = Schema.decodeUnknownEffect(KnownProviderEvent)

const makeUnknown = (raw: unknown): ProviderEvent => ({ type: "_unknown", raw })

/**
 * Parse one SSE event's `data` payload into a typed `ProviderEvent`. Never
 * fails: JSON-parse and schema-decode failures both produce a synthesized
 * `_unknown` event so consumers of `streamNative` never silently miss a
 * wire event we didn't model.
 */
/**
 * Lift events that carry a terminal failure signal (`error`,
 * `response.failed`) to a typed `AiError`. Other events are not failures
 * and produce `Option.none`.
 */
const eventToError = Match.type<ProviderEvent>().pipe(
  matchType("error", (e): AiError.AiError =>
    new AiError.Unavailable({ provider: "responses", raw: e }),
  ),
  matchType("response.failed", (e): AiError.AiError => {
    const code = e.response.error?.code
    const message = e.response.error?.message
    return new AiError.GenerationFailed({
      provider: "responses",
      ...(code !== undefined && code !== null && { code }),
      ...(message !== undefined && message !== null && { message }),
      raw: e,
    })
  }),
  Match.option,
)

const sseEventToProviderEvent = (ev: SSE.Event): Effect.Effect<ProviderEvent> =>
  Effect.try({
    try: () => JSON.parse(ev.data) as unknown,
    catch: () => ev.data,
  }).pipe(
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
    history: ReadonlyArray<Item>,
    options: ResponsesRequestOptions | undefined,
  ): Stream.Stream<ProviderEvent, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(cfg.apiKey),
          HttpClientRequest.bodyJsonUnsafe(buildBody(history, cfg.model, options)),
          HttpClientRequest.accept("text/event-stream"),
        )
        const response = yield* client
          .execute(request)
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
      return s.pipe(
        Stream.flatMap((event) => Stream.fromIterable(eventToDeltas(event, lookup))),
      )
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a `ResponsesService` value scoped to one model + http client. Use
 * this when you want to swap models per iteration via
 * `Effect.provideService(Responses, model)`. For Layer-based setup, prefer
 * `layer`.
 */
export const make = (cfg: Config): Effect.Effect<ResponsesService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => {
    const streamNative: ResponsesService["streamNative"] = (history, options) =>
      buildNativeStream(cfg)(history, options).pipe(
        Stream.provideService(HttpClient.HttpClient, client),
      )
    return {
      streamNative,
      streamTurn: (history, options) => toCanonical(streamNative(history, options)),
      toCanonical,
    }
  })

/**
 * Layer that registers both the provider-specific `Responses` tag and the
 * generic `LanguageModel` tag, sharing one underlying implementation.
 *
 * The generic tag accepts only `CommonRequestOptions`; the typed tag
 * accepts the full `ResponsesRequestOptions` surface.
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
        streamTurn: (history, options) => s.streamTurn(history, options),
      }),
    ),
  )
  return Layer.merge(typed, generic)
}
