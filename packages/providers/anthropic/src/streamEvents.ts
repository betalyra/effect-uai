import { Match, Schema } from "effect"
import {
  type Accumulator,
  WireContentBlock,
  type WireUsage,
  appendInputJsonDelta,
  appendSignatureDelta,
  appendTextDelta,
  appendThinkingDelta,
  mergeUsage,
  setStopReason,
  startBlock,
} from "./codec.js"

// ---------------------------------------------------------------------------
// Wire schemas for the SSE events we map onto our `Accumulator`. Anthropic's
// streaming protocol uses named SSE events; we match on the inner JSON
// `type` field which mirrors the event name.
// ---------------------------------------------------------------------------

const WireMessageStartUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
})

const MessageStart = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({
    id: Schema.optional(Schema.String),
    usage: Schema.optional(WireMessageStartUsage),
  }),
})

const ContentBlockStart = Schema.Struct({
  type: Schema.Literal("content_block_start"),
  index: Schema.Number,
  content_block: WireContentBlock,
})

const TextDelta = Schema.Struct({
  type: Schema.Literal("text_delta"),
  text: Schema.String,
})

const InputJsonDelta = Schema.Struct({
  type: Schema.Literal("input_json_delta"),
  partial_json: Schema.String,
})

const ThinkingDelta = Schema.Struct({
  type: Schema.Literal("thinking_delta"),
  thinking: Schema.String,
})

const SignatureDelta = Schema.Struct({
  type: Schema.Literal("signature_delta"),
  signature: Schema.String,
})

const Delta = Schema.Union([TextDelta, InputJsonDelta, ThinkingDelta, SignatureDelta])

const ContentBlockDelta = Schema.Struct({
  type: Schema.Literal("content_block_delta"),
  index: Schema.Number,
  delta: Delta,
})

const ContentBlockStop = Schema.Struct({
  type: Schema.Literal("content_block_stop"),
  index: Schema.Number,
})

const MessageDelta = Schema.Struct({
  type: Schema.Literal("message_delta"),
  delta: Schema.Struct({
    stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
    stop_sequence: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  usage: Schema.optional(WireMessageStartUsage),
})

const MessageStop = Schema.Struct({
  type: Schema.Literal("message_stop"),
})

const Ping = Schema.Struct({
  type: Schema.Literal("ping"),
})

const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
})

/**
 * Catch-all variant for wire events that fail to decode against any known
 * schema, plus events that fail to JSON-parse. The decoder never produces
 * this directly - it's synthesized by `sseEventToProviderEvent` when
 * `decodeKnown` fails.
 */
const Unknown = Schema.Struct({
  type: Schema.Literal("_unknown"),
  raw: Schema.Unknown,
})

/**
 * Internal: union of variants we actually know how to decode from the wire.
 * Used as the decode target; failures are caught and re-emitted as `Unknown`.
 */
export const KnownProviderEvent = Schema.Union([
  MessageStart,
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
  MessageDelta,
  MessageStop,
  Ping,
  ErrorEvent,
])

/**
 * Public: every event the native stream can emit. Discriminated on `type`.
 * The `_unknown` branch closes the cardinality so downstream `Match.exhaustive`
 * cannot silently miss a wire event we didn't model.
 */
export const ProviderEvent = Schema.Union([
  MessageStart,
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
  MessageDelta,
  MessageStop,
  Ping,
  ErrorEvent,
  Unknown,
])
export type ProviderEvent = typeof ProviderEvent.Type

// ---------------------------------------------------------------------------
// Apply event → Accumulator. Pure: the mapping never fails. Caller wires
// this into `Stream.mapAccum` and emits text/turn_complete deltas based on
// the diff.
// ---------------------------------------------------------------------------

const mergeOptionalUsage = (acc: Accumulator, wire: WireUsage | undefined): Accumulator =>
  wire === undefined ? acc : mergeUsage(acc, wire)

export const applyEvent = (acc: Accumulator, event: ProviderEvent): Accumulator =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      message_start: (e) => mergeOptionalUsage(acc, e.message.usage),
      content_block_start: (e) => startBlock(acc, e.index, e.content_block),
      content_block_delta: (e) =>
        Match.value(e.delta).pipe(
          Match.discriminatorsExhaustive("type")({
            text_delta: (d) => appendTextDelta(acc, e.index, d.text),
            input_json_delta: (d) => appendInputJsonDelta(acc, e.index, d.partial_json),
            thinking_delta: (d) => appendThinkingDelta(acc, e.index, d.thinking),
            signature_delta: (d) => appendSignatureDelta(acc, e.index, d.signature),
          }),
        ),
      content_block_stop: () => acc,
      message_delta: (e) => {
        const withUsage = mergeOptionalUsage(acc, e.usage)
        const reason = e.delta.stop_reason
        return reason === undefined || reason === null ? withUsage : setStopReason(withUsage, reason)
      },
      message_stop: () => acc,
      ping: () => acc,
      error: () => acc,
      // No silent drops: unknown wire events flow through `streamNative` but
      // produce no accumulator change. Step 3 (canonical `other` event) will
      // also forward them to `TurnEvent`.
      _unknown: () => acc,
    }),
  )

// ---------------------------------------------------------------------------
// Helpers for producing TurnEvent from a step.
// ---------------------------------------------------------------------------

export const isTextDeltaEvent = (
  event: ProviderEvent,
): event is Extract<
  ProviderEvent,
  { type: "content_block_delta"; delta: { type: "text_delta" } }
> => event.type === "content_block_delta" && event.delta.type === "text_delta"

export const isThinkingDeltaEvent = (
  event: ProviderEvent,
): event is Extract<
  ProviderEvent,
  { type: "content_block_delta"; delta: { type: "thinking_delta" } }
> => event.type === "content_block_delta" && event.delta.type === "thinking_delta"

export const isInputJsonDeltaEvent = (
  event: ProviderEvent,
): event is Extract<
  ProviderEvent,
  { type: "content_block_delta"; delta: { type: "input_json_delta" } }
> => event.type === "content_block_delta" && event.delta.type === "input_json_delta"

export const isToolUseStartEvent = (
  event: ProviderEvent,
): event is Extract<
  ProviderEvent,
  { type: "content_block_start"; content_block: { type: "tool_use" } }
> => event.type === "content_block_start" && event.content_block.type === "tool_use"

export const isMessageStop = (event: ProviderEvent): boolean => event.type === "message_stop"

export const isErrorEvent = (
  event: ProviderEvent,
): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error"
