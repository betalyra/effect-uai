import { Match, Schema } from "effect"
import { matchType } from "@effect-uai/core/Match"
import type { TurnDelta } from "@effect-uai/core/Turn"
import { WireOutputItem, WireResponseCompleted, turnFromCompleted } from "./codec.js"

// ---------------------------------------------------------------------------
// Schemas for the SSE event payloads we care about. The Responses API ships
// many event types; we model only the ones that map to a `TurnDelta`. All
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

const ReasoningSummaryDelta = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.delta"),
  delta: Schema.String,
})

const Completed = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: WireResponseCompleted,
})

const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
})

/**
 * Tagged union of every event we map to a TurnDelta. The `type` field is
 * the discriminator (matching the Responses API's `event:` SSE name).
 */
export const ProviderEvent = Schema.Union([
  OutputItemAdded,
  OutputTextDelta,
  FunctionArgsDelta,
  ReasoningSummaryDelta,
  Completed,
  ErrorEvent,
])
export type ProviderEvent = typeof ProviderEvent.Type

// `call_id` lookup for `function_call_arguments.delta`. The SSE event
// references the *item id*, not the call id; we keep a small map populated
// from the `output_item.added` events.
export interface CallIdLookup {
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
 * Translate a decoded provider event into zero-or-more `TurnDelta`s.
 * Mutates `lookup` to record `(item_id → call_id)` from `output_item.added`
 * so subsequent `function_call_arguments.delta` events can be tagged with
 * the right call id.
 */
export const eventToDeltas = (
  event: ProviderEvent,
  lookup: CallIdLookup,
): ReadonlyArray<TurnDelta> =>
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
    matchType("response.reasoning_summary_text.delta", ({ delta }) => [
      { type: "reasoning_summary_delta" as const, text: delta },
    ]),
    matchType("response.completed", ({ response }) => [
      { type: "turn_complete" as const, turn: turnFromCompleted(response) },
    ]),
    matchType("error", () => []), // surfaced separately as AiError
    Match.exhaustive,
  )
