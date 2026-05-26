import { Encoding, Match, Option, Schema } from "effect"
import type { ContentBlock, InputImage, HistoryItem } from "@effect-uai/core/Items"
import type { Turn } from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Wire schemas - minimal subset of the Responses API output we consume.
// Reference: https://www.openresponses.org/specification
// ---------------------------------------------------------------------------

const WireUrlCitation = Schema.Struct({
  type: Schema.Literal("url_citation"),
  url: Schema.String,
  start_index: Schema.Number,
  end_index: Schema.Number,
  title: Schema.String,
})

const WireFileCitation = Schema.Struct({
  type: Schema.Literal("file_citation"),
  file_id: Schema.String,
  index: Schema.Number,
})

const WireContainerFileCitation = Schema.Struct({
  type: Schema.Literal("container_file_citation"),
  container_id: Schema.String,
  file_id: Schema.String,
  start_index: Schema.Number,
  end_index: Schema.Number,
})

const WireFilePath = Schema.Struct({
  type: Schema.Literal("file_path"),
  file_id: Schema.String,
  index: Schema.Number,
})

const WireAnnotation = Schema.Union([
  WireUrlCitation,
  WireFileCitation,
  WireContainerFileCitation,
  WireFilePath,
])

const WireOutputTextContent = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String,
  annotations: Schema.optional(Schema.NullOr(Schema.Array(WireAnnotation))),
})

const WireRefusalContent = Schema.Struct({
  type: Schema.Literal("refusal"),
  refusal: Schema.String,
})

const WireMessageContent = Schema.Union([WireOutputTextContent, WireRefusalContent])

const WireSummaryText = Schema.Struct({
  type: Schema.Literal("summary_text"),
  text: Schema.String,
})

const WireMessage = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.optional(Schema.String),
  role: Schema.Literal("assistant"),
  content: Schema.Array(WireMessageContent),
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

const WireInputTokensDetails = Schema.Struct({
  cached_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
})

const WireOutputTokensDetails = Schema.Struct({
  reasoning_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
})

const WireUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  input_tokens_details: Schema.optional(Schema.NullOr(WireInputTokensDetails)),
  output_tokens_details: Schema.optional(Schema.NullOr(WireOutputTokensDetails)),
})

const WireResponseError = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
})

// Many Responses-API fields are emitted as explicit `null` rather than
// missing - `Schema.optional` alone (T | undefined) doesn't cover that, so
// we lift each through `NullOr` first. Used by `response.completed`,
// `response.incomplete`, and `response.failed` events; not every field is
// populated on every event (e.g. `error` only on failed, `incomplete_details`
// only on incomplete).
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
  error: Schema.optional(Schema.NullOr(WireResponseError)),
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
const passthrough = (item: HistoryItem): Record<string, unknown> | undefined =>
  item.providerData !== undefined &&
  typeof item.providerData === "object" &&
  item.providerData !== null
    ? (item.providerData as Record<string, unknown>)
    : undefined

/**
 * OpenAI's `input_image` content block carries a single `image_url` field;
 * inline bytes get encoded as a `data:` URI. Either form (URL or data URI)
 * is fine - the model just dereferences `image_url`.
 */
const imageSourceToUrl = Match.type<InputImage["source"]>().pipe(
  Match.tag("url", (s) => s.url),
  Match.tag("base64", (s) => `data:${s.mimeType};base64,${s.base64}`),
  Match.tag("bytes", (s) => `data:${s.mimeType};base64,${Encoding.encodeBase64(s.bytes)}`),
  Match.exhaustive,
)

const contentBlockToInput = Match.type<ContentBlock>().pipe(
  Match.discriminatorsExhaustive("type")({
    input_text: (b) => ({ type: "input_text", text: b.text }),
    input_image: (b) => ({
      type: "input_image",
      image_url: imageSourceToUrl(b.source),
    }),
    output_text: (b) => ({ type: "output_text", text: b.text }),
    refusal: (b) => ({ type: "refusal", refusal: b.text }),
  }),
)

const itemToInput = (item: HistoryItem): Record<string, unknown> =>
  passthrough(item) ??
  Match.value(item).pipe(
    Match.discriminatorsExhaustive("type")({
      message: (m) => ({
        type: "message",
        role: m.role,
        content: m.content.map(contentBlockToInput),
      }),
      function_call: (f) => ({
        type: "function_call",
        call_id: f.call_id,
        name: f.name,
        arguments: f.arguments,
      }),
      function_call_output: (o) => ({
        type: "function_call_output",
        call_id: o.call_id,
        output: o.output,
      }),
      reasoning: (r) => ({
        type: "reasoning",
        ...(r.id !== undefined && { id: r.id }),
        ...(r.summary !== undefined && {
          summary: [{ type: "summary_text", text: r.summary }],
        }),
        ...(r.signature !== undefined && { encrypted_content: r.signature }),
      }),
    }),
  )

/** Convert our `HistoryItem[]` history into the Responses API `input` array. */
export const itemsToInput = (items: ReadonlyArray<HistoryItem>): ReadonlyArray<Record<string, unknown>> =>
  items.map(itemToInput)

// ---------------------------------------------------------------------------
// Wire output items → our Items
// ---------------------------------------------------------------------------

const wireMessageContentToBlock = Match.type<typeof WireMessageContent.Type>().pipe(
  Match.discriminatorsExhaustive("type")({
    output_text: (c): ContentBlock => ({
      type: "output_text",
      text: c.text,
      ...(c.annotations !== undefined && c.annotations !== null && { annotations: c.annotations }),
    }),
    refusal: (c): ContentBlock => ({ type: "refusal", text: c.refusal }),
  }),
)

export const wireItemToItem = (wire: WireOutputItem): HistoryItem =>
  Match.value(wire).pipe(
    Match.discriminatorsExhaustive("type")({
      message: (m) => ({
        type: "message" as const,
        role: m.role,
        content: m.content.map(wireMessageContentToBlock),
        providerData: m,
      }),
      function_call: (f) => ({
        type: "function_call" as const,
        call_id: f.call_id,
        name: f.name,
        arguments: f.arguments,
        providerData: f,
      }),
      reasoning: (r) => ({
        type: "reasoning" as const,
        ...(r.id !== undefined && { id: r.id }),
        ...(r.summary !== undefined && {
          summary: r.summary.map((s) => s.text).join("\n"),
        }),
        ...(r.encrypted_content !== undefined && { signature: r.encrypted_content }),
        providerData: r,
      }),
    }),
  )

// ---------------------------------------------------------------------------
// response.completed → Turn
// ---------------------------------------------------------------------------

const reasonToStop = Match.type<string>().pipe(
  Match.when("max_output_tokens", () => "max_tokens" as const),
  Match.when("refusal", () => "refusal" as const),
  Match.when("content_filter", () => "content_filter" as const),
  Match.when("max_tool_calls", () => "max_tool_calls" as const),
  Match.option,
)

const hasRefusalContent = (payload: WireResponseCompleted): boolean =>
  (payload.output ?? []).some(
    (i) => i.type === "message" && i.content.some((c) => c.type === "refusal"),
  )

const stopReasonFromCompleted = (payload: WireResponseCompleted): Turn["stop_reason"] =>
  Option.match(reasonToStop(payload.incomplete_details?.reason ?? ""), {
    onSome: (s) => s,
    onNone: () =>
      hasRefusalContent(payload)
        ? ("refusal" as const)
        : (payload.output ?? []).some((i) => i.type === "function_call")
          ? ("tool_calls" as const)
          : ("stop" as const),
  })

const cachedTokens = (payload: WireResponseCompleted): number | undefined =>
  payload.usage?.input_tokens_details?.cached_tokens ?? undefined

const reasoningTokens = (payload: WireResponseCompleted): number | undefined =>
  payload.usage?.output_tokens_details?.reasoning_tokens ?? undefined

export const turnFromCompleted = (payload: WireResponseCompleted): Turn => {
  const cached = cachedTokens(payload)
  const reasoning = reasoningTokens(payload)
  return {
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
      ...(cached !== undefined && {
        input_tokens_details: { cached_tokens: cached },
      }),
      ...(reasoning !== undefined && {
        output_tokens_details: { reasoning_tokens: reasoning },
      }),
    },
    stop_reason: stopReasonFromCompleted(payload),
  }
}
