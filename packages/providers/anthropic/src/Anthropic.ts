import { Context, Effect, Layer, Match, Option, Redacted, Result, Schema, Stream, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { Item } from "@effect-uai/core/Items"
import {
  type CommonRequestOptions,
  LanguageModel,
  type LanguageModelService,
} from "@effect-uai/core/LanguageModel"
import { matchType } from "@effect-uai/core/Match"
import * as SSE from "@effect-uai/core/SSE"
import type { TurnEvent } from "@effect-uai/core/Turn"
import {
  type Accumulator,
  type ThinkingConfig,
  accumulatorToTurn,
  buildRequestBody,
  emptyAccumulator,
} from "./codec.js"
import type { AnthropicModel } from "./models.js"
import { KnownProviderEvent, ProviderEvent, applyEvent } from "./streamEvents.js"

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
  /**
   * Stream the provider's native event vocabulary (post-SSE-decode).
   * Use this when you need full vendor fidelity (e.g. `signature_delta` for
   * encrypted reasoning state). For provider-portable code, use `streamTurn`.
   */
  readonly streamNative: (
    history: ReadonlyArray<Item>,
    options?: AnthropicRequestOptions,
  ) => Stream.Stream<ProviderEvent, AiError.AiError>
  /**
   * Stream canonical `TurnEvent`s. Implemented as
   * `streamNative |> toCanonical`.
   */
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: AnthropicRequestOptions,
  ) => Stream.Stream<TurnEvent, AiError.AiError>
  /**
   * Project a stream of native `ProviderEvent`s into canonical `TurnEvent`s.
   * Stateful (threads an `Accumulator` for tool-call lookup and
   * accumulator-to-Turn assembly).
   */
  readonly toCanonical: <E, R>(
    s: Stream.Stream<ProviderEvent, E, R>,
  ) => Stream.Stream<TurnEvent, E, R>
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

const decodeKnown = Schema.decodeUnknownEffect(KnownProviderEvent)

const makeUnknown = (raw: unknown): ProviderEvent => ({ type: "_unknown", raw })

/**
 * Parse one SSE event's `data` payload into a typed `ProviderEvent`. Never
 * fails: JSON-parse and schema-decode failures both produce a synthesized
 * `_unknown` event so consumers of `streamNative` never silently miss a
 * wire event we didn't model.
 */
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
// Per-event derivation of TurnEvents. Drives off the new accumulator and the
// raw event, since some deltas (`tool_call_args_delta`) need the call_id
// which lives on the accumulator's per-index block.
// ---------------------------------------------------------------------------

const deltasFromEvent = (
  next: Accumulator,
  event: ProviderEvent,
): ReadonlyArray<TurnEvent> =>
  Match.value(event).pipe(
    matchType("content_block_start", (e) =>
      e.content_block.type === "tool_use"
        ? [
            {
              type: "tool_call_start" as const,
              call_id: e.content_block.id,
              name: e.content_block.name,
            },
          ]
        : [],
    ),
    matchType("content_block_delta", (e) =>
      Match.value(e.delta).pipe(
        matchType("text_delta", (d) => [{ type: "text_delta" as const, text: d.text }]),
        matchType("thinking_delta", (d) => [
          { type: "reasoning_delta" as const, text: d.thinking, kind: "trace" as const },
        ]),
        matchType("input_json_delta", (d) => {
          const block = next.blocks[e.index]
          if (block === undefined) return []
          const callId = Option.getOrElse(block.id, () => "")
          return callId.length === 0
            ? []
            : [
                {
                  type: "tool_call_args_delta" as const,
                  call_id: callId,
                  delta: d.partial_json,
                },
              ]
        }),
        // Encrypted reasoning state - flows through `streamNative` but has
        // no canonical representation.
        matchType("signature_delta", () => []),
        Match.exhaustive,
      ),
    ),
    matchType("message_start", (e) =>
      e.message.usage === undefined
        ? []
        : [{ type: "usage_update" as const, usage: next.usage }],
    ),
    matchType("message_delta", (e) =>
      e.usage === undefined
        ? []
        : [{ type: "usage_update" as const, usage: next.usage }],
    ),
    matchType("message_stop", () => [
      { type: "turn_complete" as const, turn: accumulatorToTurn(next) },
    ]),
    matchType("content_block_stop", () => []),
    matchType("ping", () => []),
    matchType("error", () => []),
    matchType("_unknown", () => []),
    Match.exhaustive,
  )

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

const buildNativeStream = (cfg: Config) => {
  const baseUrl = cfg.baseUrl ?? "https://api.anthropic.com"
  const url = `${baseUrl}/v1/messages`
  return (
    history: ReadonlyArray<Item>,
    options: Option.Option<AnthropicRequestOptions>,
  ): Stream.Stream<ProviderEvent, AiError.AiError, HttpClient.HttpClient> =>
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
          Stream.mapEffect(sseEventToProviderEvent),
          Stream.flatMap((event) =>
            event.type === "error"
              ? Stream.fail(
                  new AiError.Unavailable({ provider: "anthropic", raw: event }),
                )
              : Stream.succeed(event),
          ),
        )
      }),
    )
}

/**
 * Project a stream of native `ProviderEvent`s into canonical `TurnEvent`s.
 * Threads a fresh `Accumulator` per stream so tool-call lookup and
 * `accumulatorToTurn` assembly work correctly across the run.
 */
export const toCanonical = <E, R>(
  s: Stream.Stream<ProviderEvent, E, R>,
): Stream.Stream<TurnEvent, E, R> =>
  s.pipe(
    Stream.mapAccum(
      () => emptyAccumulator,
      (acc, event) => {
        const next = applyEvent(acc, event)
        const deltas = deltasFromEvent(next, event)
        return [next, deltas] as const
      },
    ),
  )

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
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => {
    const streamNative: AnthropicService["streamNative"] = (history, options) =>
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
