import { Match, Schema } from "effect"
import type { Item } from "@betalyra/effect-uai-core/Items"
import { matchType } from "@betalyra/effect-uai-core/Match"
import type { Turn } from "@betalyra/effect-uai-core/Turn"

// ---------------------------------------------------------------------------
// Wire schemas - minimal subset of the Responses API output we consume.
// Reference: https://www.openresponses.org/specification
// ---------------------------------------------------------------------------

const WireOutputTextContent = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String,
})

const WireSummaryText = Schema.Struct({
  type: Schema.Literal("summary_text"),
  text: Schema.String,
})

const WireMessage = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.optional(Schema.String),
  role: Schema.Literal("assistant"),
  content: Schema.Array(WireOutputTextContent),
})

const WireFunctionCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  id: Schema.optional(Schema.String),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
})

const WireReasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.Array(WireSummaryText)),
  encrypted_content: Schema.optional(Schema.String),
})

export const WireOutputItem = Schema.Union([WireMessage, WireFunctionCall, WireReasoning])
export type WireOutputItem = typeof WireOutputItem.Type

const WireUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
})

// Many Responses-API fields are emitted as explicit `null` rather than
// missing - `Schema.optional` alone (T | undefined) doesn't cover that, so
// we lift each through `NullOr` first.
export const WireResponseCompleted = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  output: Schema.optional(Schema.NullOr(Schema.Array(WireOutputItem))),
  usage: Schema.optional(Schema.NullOr(WireUsage)),
  incomplete_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reason: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
export type WireResponseCompleted = typeof WireResponseCompleted.Type

// ---------------------------------------------------------------------------
// History → request body input
// ---------------------------------------------------------------------------

/**
 * If an item carries `providerData` from a prior OpenAI turn, re-emit it
 * verbatim - preserves `encrypted_content`, item ids, and any field this
 * codec doesn't model.
 */
const passthrough = (item: Item): Record<string, unknown> | undefined =>
  item.providerData !== undefined &&
  typeof item.providerData === "object" &&
  item.providerData !== null
    ? (item.providerData as Record<string, unknown>)
    : undefined

const itemToInput = (item: Item): Record<string, unknown> =>
  passthrough(item) ??
  Match.value(item).pipe(
    matchType("message", (m) => ({
      type: "message",
      role: m.role,
      content: m.content.map((c) => ({ type: c.type, text: c.text })),
    })),
    matchType("function_call", (f) => ({
      type: "function_call",
      call_id: f.call_id,
      name: f.name,
      arguments: f.arguments,
    })),
    matchType("function_call_output", (o) => ({
      type: "function_call_output",
      call_id: o.call_id,
      output: o.output,
    })),
    matchType("reasoning", (r) => ({
      type: "reasoning",
      ...(r.id !== undefined && { id: r.id }),
      ...(r.summary !== undefined && {
        summary: [{ type: "summary_text", text: r.summary }],
      }),
      ...(r.signature !== undefined && { encrypted_content: r.signature }),
    })),
    Match.exhaustive,
  )

/** Convert our `Item[]` history into the Responses API `input` array. */
export const itemsToInput = (items: ReadonlyArray<Item>): ReadonlyArray<Record<string, unknown>> =>
  items.map(itemToInput)

// ---------------------------------------------------------------------------
// Wire output items → our Items
// ---------------------------------------------------------------------------

export const wireItemToItem = (wire: WireOutputItem): Item =>
  Match.value(wire).pipe(
    matchType("message", (m) => ({
      type: "message" as const,
      role: m.role,
      content: m.content.map((c) => ({
        type: "output_text" as const,
        text: c.text,
      })),
      providerData: m,
    })),
    matchType("function_call", (f) => ({
      type: "function_call" as const,
      call_id: f.call_id,
      name: f.name,
      arguments: f.arguments,
      providerData: f,
    })),
    matchType("reasoning", (r) => ({
      type: "reasoning" as const,
      ...(r.id !== undefined && { id: r.id }),
      ...(r.summary !== undefined && {
        summary: r.summary.map((s) => s.text).join("\n"),
      }),
      ...(r.encrypted_content !== undefined && { signature: r.encrypted_content }),
      providerData: r,
    })),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// response.completed → Turn
// ---------------------------------------------------------------------------

const stopReasonFromCompleted = (payload: WireResponseCompleted): Turn["stop_reason"] => {
  if (payload.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens"
  }
  const output = payload.output ?? []
  return output.some((i) => i.type === "function_call") ? "tool_calls" : "stop"
}

export const turnFromCompleted = (payload: WireResponseCompleted): Turn => ({
  items: (payload.output ?? []).map(wireItemToItem),
  usage: {
    ...(payload.usage?.input_tokens !== undefined && {
      input_tokens: payload.usage.input_tokens,
    }),
    ...(payload.usage?.output_tokens !== undefined && {
      output_tokens: payload.usage.output_tokens,
    }),
    ...(payload.usage?.total_tokens !== undefined && {
      total_tokens: payload.usage.total_tokens,
    }),
  },
  stop_reason: stopReasonFromCompleted(payload),
})
