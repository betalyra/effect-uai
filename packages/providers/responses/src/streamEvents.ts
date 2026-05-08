import { Match, Schema } from "effect"
import { matchType } from "@effect-uai/core/Match"
import type { TurnEvent } from "@effect-uai/core/Turn"
import { WireOutputItem, WireResponseCompleted, turnFromCompleted } from "./codec.js"

// ---------------------------------------------------------------------------
// Schemas for the SSE event payloads we care about. The Responses API ships
// many event types; we model only the ones that map to a `TurnEvent`. All
// others are silently ignored at the dispatch site.
// ---------------------------------------------------------------------------

const OutputItemAdded = Schema.Struct({
  type: Schema.Literal("response.output_item.added"),
  item: WireOutputItem,
})

const OutputTextDelta = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  delta: Schema.String,
})

const FunctionArgsDelta = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.delta"),
  item_id: Schema.String,
  delta: Schema.String,
})

const ReasoningTextDelta = Schema.Struct({
  type: Schema.Literal("response.reasoning_text.delta"),
  delta: Schema.String,
})

const ReasoningSummaryDelta = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.delta"),
  delta: Schema.String,
})

const RefusalDelta = Schema.Struct({
  type: Schema.Literal("response.refusal.delta"),
  delta: Schema.String,
})

const RefusalDone = Schema.Struct({
  type: Schema.Literal("response.refusal.done"),
  refusal: Schema.optional(Schema.String),
})

const Completed = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: WireResponseCompleted,
})

const Incomplete = Schema.Struct({
  type: Schema.Literal("response.incomplete"),
  response: WireResponseCompleted,
})

const Failed = Schema.Struct({
  type: Schema.Literal("response.failed"),
  response: WireResponseCompleted,
})

const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
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
  OutputItemAdded,
  OutputTextDelta,
  FunctionArgsDelta,
  ReasoningTextDelta,
  ReasoningSummaryDelta,
  RefusalDelta,
  RefusalDone,
  Completed,
  Incomplete,
  Failed,
  ErrorEvent,
])

/**
 * Public: every event the native stream can emit. Discriminated on `type`.
 * The `_unknown` branch closes the cardinality so downstream `Match.exhaustive`
 * cannot silently miss a wire event we didn't model.
 */
export const ProviderEvent = Schema.Union([
  OutputItemAdded,
  OutputTextDelta,
  FunctionArgsDelta,
  ReasoningTextDelta,
  ReasoningSummaryDelta,
  RefusalDelta,
  RefusalDone,
  Completed,
  Incomplete,
  Failed,
  ErrorEvent,
  Unknown,
])
export type ProviderEvent = typeof ProviderEvent.Type

// `call_id` lookup for `function_call_arguments.delta`. The SSE event
// references the *item id*, not the call id; we keep a small map populated
// from the `output_item.added` events.
export type CallIdLookup = {
  readonly resolve: (itemId: string) => string | undefined
  readonly remember: (itemId: string, callId: string) => void
}

export const makeCallIdLookup = (): CallIdLookup => {
  const map = new Map<string, string>()
  return {
    resolve: (id) => map.get(id),
    remember: (id, callId) => {
      map.set(id, callId)
    },
  }
}

/**
 * Translate a decoded provider event into zero-or-more `TurnEvent`s.
 * Mutates `lookup` to record `(item_id → call_id)` from `output_item.added`
 * so subsequent `function_call_arguments.delta` events can be tagged with
 * the right call id.
 */
export const eventToDeltas = (
  event: ProviderEvent,
  lookup: CallIdLookup,
): ReadonlyArray<TurnEvent> =>
  Match.value(event).pipe(
    matchType("response.output_item.added", ({ item }) => {
      if (item.type !== "function_call") return []
      if (item.id !== undefined) lookup.remember(item.id, item.call_id)
      return [
        {
          type: "tool_call_start" as const,
          call_id: item.call_id,
          name: item.name,
        },
      ]
    }),
    matchType("response.output_text.delta", ({ delta }) => [
      { type: "text_delta" as const, text: delta },
    ]),
    matchType("response.function_call_arguments.delta", ({ item_id, delta }) => {
      const call_id = lookup.resolve(item_id)
      return call_id === undefined
        ? []
        : [{ type: "tool_call_args_delta" as const, call_id, delta }]
    }),
    matchType("response.reasoning_text.delta", ({ delta }) => [
      { type: "reasoning_delta" as const, text: delta, kind: "trace" as const },
    ]),
    matchType("response.reasoning_summary_text.delta", ({ delta }) => [
      { type: "reasoning_delta" as const, text: delta, kind: "summary" as const },
    ]),
    matchType("response.refusal.delta", ({ delta }) => [
      { type: "refusal_delta" as const, text: delta },
    ]),
    // Terminal marker for the refusal stream; the deltas already covered
    // the text, so no canonical event is emitted here.
    matchType("response.refusal.done", () => []),
    matchType("response.completed", ({ response }) => [
      { type: "turn_complete" as const, turn: turnFromCompleted(response) },
    ]),
    // Incomplete = the model stopped early but produced a usable partial
    // turn (max_tokens, content_filter, max_tool_calls, refusal). Same
    // payload shape as `response.completed`; the stop_reason carries the
    // reason.
    matchType("response.incomplete", ({ response }) => [
      { type: "turn_complete" as const, turn: turnFromCompleted(response) },
    ]),
    // Failed and error are surfaced separately as `AiError` by the stream
    // pipeline, not as canonical events.
    matchType("response.failed", () => []),
    matchType("error", () => []),
    // No silent drops: unknown wire events flow through `streamNative` but
    // produce no canonical delta. Step 3 (canonical `other` event) replaces
    // this with a forwarded `other` delta on `TurnEvent`.
    matchType("_unknown", () => []),
    Match.exhaustive,
  )
