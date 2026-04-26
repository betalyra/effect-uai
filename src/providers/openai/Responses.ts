import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { AiError } from "../../AiError.js"
import type { Item } from "../../Items.js"
import {
  type CommonRequestOptions,
  LanguageModel,
  type LanguageModelService,
} from "../../LanguageModel.js"
import { JsonParseError } from "../../JSONL.js"
import * as SSE from "../../SSE.js"
import type { TurnDelta } from "../../Turn.js"
import { itemsToInput } from "./codec.js"
import { ProviderEvent, eventToDeltas, makeCallIdLookup } from "./streamEvents.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenAiRequestOptions extends CommonRequestOptions {
  readonly reasoning?: { readonly effort: "low" | "medium" | "high" }
  readonly store?: boolean
  readonly previousResponseId?: string
}

export interface OpenAiService {
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: OpenAiRequestOptions,
  ) => Stream.Stream<TurnDelta, AiError>
}

/**
 * Provider-typed service tag. Yield this when you want OpenAI-specific
 * options (`reasoning.effort`, `store`, ...) at the call site. Yield the
 * generic `LanguageModel` tag for provider-portable code — both are
 * registered by `OpenAiResponses.layer`.
 */
export class OpenAi extends Context.Service<OpenAi, OpenAiService>()(
  "@betalyra/effect-uai/providers/openai/Responses",
) {}

export interface Config {
  readonly apiKey: Redacted.Redacted | string
  readonly model: string
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const buildBody = (
  history: ReadonlyArray<Item>,
  model: string,
  options: OpenAiRequestOptions | undefined,
): Record<string, unknown> => ({
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
})

// ---------------------------------------------------------------------------
// SSE event → provider event
// ---------------------------------------------------------------------------

const decodeProviderEvent = Schema.decodeUnknownEffect(ProviderEvent)

/**
 * Parse one SSE event's `data` payload into a typed `ProviderEvent`.
 * JSON-parse failures and schema-decode failures both produce
 * `Option.none()` — unknown event types are silently ignored.
 */
const sseEventToProviderEvent = (ev: SSE.Event): Effect.Effect<Option.Option<ProviderEvent>> =>
  Effect.try({
    try: () => JSON.parse(ev.data) as unknown,
    catch: (cause) => new JsonParseError({ line: ev.data, cause }),
  }).pipe(Effect.flatMap(decodeProviderEvent), Effect.option)

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const httpStatusError = (status: number, body: string): AiError =>
  new AiError({
    message: `OpenAI Responses returned ${status}${body.length > 0 ? `: ${body}` : ""}`,
  })

const buildStream = (cfg: Config) => {
  const url = `${cfg.baseUrl ?? "https://api.openai.com/v1"}/responses`
  return (
    history: ReadonlyArray<Item>,
    options: OpenAiRequestOptions | undefined,
  ): Stream.Stream<TurnDelta, AiError, HttpClient.HttpClient> =>
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
          .pipe(Effect.mapError((cause) => new AiError({ message: "HTTP request failed", cause })))
        if (response.status >= 400) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return Stream.fail(httpStatusError(response.status, body))
        }

        const lookup = makeCallIdLookup()
        return response.stream.pipe(
          Stream.mapError((cause) => new AiError({ message: "Response stream error", cause })),
          SSE.fromBytes,
          Stream.mapEffect(sseEventToProviderEvent),
          Stream.flatMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: (event) =>
                event.type === "error"
                  ? Stream.fail(
                      new AiError({
                        message: event.message ?? "Unknown OpenAI error",
                      }),
                    )
                  : Stream.fromIterable(eventToDeltas(event, lookup)),
            }),
          ),
        )
      }),
    )
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build an `OpenAiService` value scoped to one model + http client. Use
 * this when you want to swap models per iteration via
 * `Effect.provideService(OpenAi, model)`. For Layer-based setup, prefer
 * `layer`.
 */
export const make = (cfg: Config): Effect.Effect<OpenAiService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    streamTurn: (history, options) =>
      buildStream(cfg)(history, options).pipe(Stream.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer that registers both the provider-specific `OpenAi` tag and the
 * generic `LanguageModel` tag, sharing one underlying implementation.
 *
 * The generic tag accepts only `CommonRequestOptions`; the typed tag
 * accepts the full `OpenAiRequestOptions` surface.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<OpenAi | LanguageModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(OpenAi, make(cfg))
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
