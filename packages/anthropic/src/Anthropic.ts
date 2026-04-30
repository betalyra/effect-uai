import { Context, Effect, Layer, Option, Redacted, Result, Schema, Stream, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@betalyra/effect-uai-core/AiError"
import type { Item } from "@betalyra/effect-uai-core/Items"
import {
  type CommonRequestOptions,
  LanguageModel,
  type LanguageModelService,
} from "@betalyra/effect-uai-core/LanguageModel"
import { JsonParseError } from "@betalyra/effect-uai-core/JSONL"
import * as SSE from "@betalyra/effect-uai-core/SSE"
import type { TurnDelta } from "@betalyra/effect-uai-core/Turn"
import {
  type Accumulator,
  type ThinkingConfig,
  accumulatorToTurn,
  buildRequestBody,
  emptyAccumulator,
} from "./codec.js"
import type { AnthropicModel } from "./models.js"
import { ProviderEvent, applyEvent } from "./streamEvents.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnthropicRequestOptions extends CommonRequestOptions {
  /**
   * Top-K nucleus sampling parameter. Anthropic-specific; not exposed on the
   * common surface.
   */
  readonly topK?: number
  /** Stop sequences that abort generation when matched. */
  readonly stopSequences?: ReadonlyArray<string>
  /**
   * Extended thinking configuration. `0` budget is equivalent to disabled.
   * Only the `claude-sonnet-4-x`, `claude-haiku-4-x`, and pre-Opus-4.7
   * model lines support extended thinking.
   */
  readonly thinking?: ThinkingConfig
  /**
   * `metadata.user_id` on the wire. End-user tracking identifier.
   */
  readonly user?: string
}

export interface AnthropicService {
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: AnthropicRequestOptions,
  ) => Stream.Stream<TurnDelta, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this when you want Anthropic-specific
 * options (`topK`, `stopSequences`, `thinking`); yield the generic
 * `LanguageModel` tag for provider-portable code. Both are registered by
 * `layer`.
 */
export class Anthropic extends Context.Service<Anthropic, AnthropicService>()(
  "@betalyra/effect-uai/providers/anthropic/Anthropic",
) {}

export interface Config {
  readonly apiKey: Redacted.Redacted
  readonly model: AnthropicModel
  readonly baseUrl?: string
  /**
   * Default `max_tokens` for requests that don't override via
   * `options.maxOutputTokens`. Anthropic requires this field; we default to
   * 4096 if not set on either layer or per-call.
   */
  readonly defaultMaxTokens?: number
}

const ANTHROPIC_VERSION = "2023-06-01"
const FALLBACK_MAX_TOKENS = 4096

const resolvedMaxTokens = (
  cfg: Config,
  options: Option.Option<AnthropicRequestOptions>,
): number =>
  pipe(
    options,
    Option.flatMap((o) => Option.fromUndefinedOr(o.maxOutputTokens)),
    Option.getOrElse(() => cfg.defaultMaxTokens ?? FALLBACK_MAX_TOKENS),
  )

const toolDescriptors = (
  options: Option.Option<AnthropicRequestOptions>,
): Option.Option<ReadonlyArray<Record<string, unknown>>> =>
  pipe(
    options,
    Option.flatMap((o) =>
      o.tools !== undefined && o.tools.length > 0 ? Option.some(o.tools) : Option.none(),
    ),
    Option.map((tools) =>
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    ),
  )

const toolChoiceWire = (
  options: Option.Option<AnthropicRequestOptions>,
): Option.Option<Record<string, unknown>> =>
  pipe(
    options,
    Option.flatMap((o) => Option.fromUndefinedOr(o.toolChoice)),
    Option.map((choice) =>
      choice === "auto"
        ? { type: "auto" }
        : choice === "required"
          ? { type: "any" }
          : choice === "none"
            ? { type: "none" }
            : { type: "tool", name: choice.name },
    ),
  )

// ---------------------------------------------------------------------------
// SSE event → ProviderEvent
// ---------------------------------------------------------------------------

const decodeProviderEvent = Schema.decodeUnknownEffect(ProviderEvent)

const sseEventToProviderEvent = (
  ev: SSE.Event,
): Effect.Effect<Option.Option<ProviderEvent>> =>
  Effect.try({
    try: () => JSON.parse(ev.data) as unknown,
    catch: (cause) => new JsonParseError({ line: ev.data, cause }),
  }).pipe(Effect.flatMap(decodeProviderEvent), Effect.option)

// ---------------------------------------------------------------------------
// Per-event derivation of TurnDeltas. Drives off the new accumulator and the
// raw event, since some deltas (`tool_call_args_delta`) need the call_id
// which lives on the accumulator's per-index block.
// ---------------------------------------------------------------------------

const deltasFromEvent = (
  prev: Accumulator,
  next: Accumulator,
  event: ProviderEvent,
): ReadonlyArray<TurnDelta> => {
  if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
    return [
      {
        type: "tool_call_start",
        call_id: event.content_block.id,
        name: event.content_block.name,
      },
    ]
  }
  if (event.type === "content_block_delta") {
    if (event.delta.type === "text_delta") {
      return [{ type: "text_delta", text: event.delta.text }]
    }
    if (event.delta.type === "thinking_delta") {
      return [{ type: "reasoning_summary_delta", text: event.delta.thinking }]
    }
    if (event.delta.type === "input_json_delta") {
      const block = next.blocks[event.index]
      if (block === undefined) return []
      const callId = Option.getOrElse(block.id, () => "")
      return callId.length === 0
        ? []
        : [
            {
              type: "tool_call_args_delta",
              call_id: callId,
              delta: event.delta.partial_json,
            },
          ]
    }
    return []
  }
  if (event.type === "message_stop") {
    return [{ type: "turn_complete", turn: accumulatorToTurn(next) }]
  }
  // Reference `prev` so it remains part of the readable signature even
  // though no current path needs it. This stays a real parameter so that
  // future deltas (e.g. usage diffs) can compute against the previous
  // accumulator state without an API change.
  void prev
  return []
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "anthropic"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status === 413) return new AiError.ContextLengthExceeded({ provider, raw })
  if (status === 529) return new AiError.Unavailable({ provider, status, raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

const buildStream = (cfg: Config) => {
  const baseUrl = cfg.baseUrl ?? "https://api.anthropic.com"
  const url = `${baseUrl}/v1/messages`
  return (
    history: ReadonlyArray<Item>,
    options: Option.Option<AnthropicRequestOptions>,
  ): Stream.Stream<TurnDelta, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const optionsField = <K extends keyof AnthropicRequestOptions>(
          key: K,
        ): Option.Option<NonNullable<AnthropicRequestOptions[K]>> =>
          pipe(
            options,
            Option.flatMap((o) => Option.fromUndefinedOr(o[key])),
          )

        const bodyResult = buildRequestBody({
          model: cfg.model,
          history,
          maxTokens: resolvedMaxTokens(cfg, options),
          temperature: optionsField("temperature"),
          topP: optionsField("topP"),
          topK: optionsField("topK"),
          stopSequences: optionsField("stopSequences"),
          thinking: optionsField("thinking"),
          tools: toolDescriptors(options),
          toolChoice: toolChoiceWire(options),
          userId: optionsField("user"),
        })

        const body = yield* Result.match(bodyResult, {
          onFailure: (cause) =>
            Effect.fail(
              new AiError.InvalidRequest({
                provider: "anthropic",
                param: "input.function_call.arguments",
                raw: cause,
              }),
            ),
          onSuccess: (b) => Effect.succeed(b),
        })

        const client = yield* HttpClient.HttpClient
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("x-api-key", Redacted.value(cfg.apiKey)),
          HttpClientRequest.setHeader("anthropic-version", ANTHROPIC_VERSION),
          HttpClientRequest.bodyJsonUnsafe(body),
          HttpClientRequest.accept("text/event-stream"),
        )
        const response = yield* client
          .execute(request)
          .pipe(
            Effect.mapError(
              (cause): AiError.AiError =>
                new AiError.Unavailable({ provider: "anthropic", raw: cause }),
            ),
          )
        if (response.status >= 400) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return Stream.fail(httpStatusError(response.status, text))
        }

        return response.stream.pipe(
          Stream.mapError(
            (cause): AiError.AiError =>
              new AiError.Unavailable({ provider: "anthropic", raw: cause }),
          ),
          SSE.fromBytes,
          Stream.mapEffect((ev) =>
            sseEventToProviderEvent(ev).pipe(
              Effect.mapError(
                (cause): AiError.AiError =>
                  new AiError.Unavailable({ provider: "anthropic", raw: cause }),
              ),
            ),
          ),
          Stream.flatMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: (event) =>
                event.type === "error"
                  ? Stream.fail(
                      new AiError.Unavailable({ provider: "anthropic", raw: event }),
                    )
                  : Stream.succeed(event),
            }),
          ),
          Stream.mapAccum(
            (): Accumulator => emptyAccumulator,
            (acc, event) => {
              const next = applyEvent(acc, event)
              const deltas = deltasFromEvent(acc, next, event)
              return [next, deltas] as const
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
 * Build an `AnthropicService` value scoped to one model + http client. Use
 * this when you want to swap models per iteration via
 * `Effect.provideService(Anthropic, model)`. For Layer-based setup, prefer
 * `layer`.
 */
export const make = (
  cfg: Config,
): Effect.Effect<AnthropicService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    streamTurn: (history, options) =>
      buildStream(cfg)(history, Option.fromUndefinedOr(options)).pipe(
        Stream.provideService(HttpClient.HttpClient, client),
      ),
  }))

/**
 * Layer that registers both the provider-specific `Anthropic` tag and the
 * generic `LanguageModel` tag, sharing one underlying implementation.
 *
 * The generic tag accepts only `CommonRequestOptions`; the typed tag
 * accepts the full `AnthropicRequestOptions` surface.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<Anthropic | LanguageModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(Anthropic, make(cfg))
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
