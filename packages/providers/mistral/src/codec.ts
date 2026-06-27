import { Array as Arr, Encoding, Match, Option, Schema } from "effect"
import type {
  ContentBlock,
  HistoryItem,
  InputImage,
  StopReason,
  Usage,
} from "@effect-uai/core/Items"
import type { StructuredFormat } from "@effect-uai/core/StructuredFormat"
import type { ToolDescriptor } from "@effect-uai/core/Tool"
import type { Turn } from "@effect-uai/core/Turn"
import { TurnEvent } from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// History → Mistral chat `messages`
//
// Mistral speaks the OpenAI chat-completions dialect: a flat list of
// `{ role, content, ... }` objects where an assistant turn's tool calls live
// on the assistant message (`tool_calls`) and each tool result is its own
// `{ role: "tool", tool_call_id, content }` message. Our history is a flatter
// item list (assistant message, then separate `function_call` items), so we
// fold consecutive `function_call`s onto the preceding assistant message.
// ---------------------------------------------------------------------------

type WireMessage = {
  role: string
  content: string | ReadonlyArray<Record<string, unknown>>
  tool_calls?: ReadonlyArray<Record<string, unknown>>
  tool_call_id?: string
}

/** A `data:` URI for inline image bytes; URLs pass through untouched. */
const imageSourceToUrl = Match.type<InputImage["source"]>().pipe(
  Match.tag("url", (s) => s.url),
  Match.tag("base64", (s) => `data:${s.mimeType};base64,${s.base64}`),
  Match.tag("bytes", (s) => `data:${s.mimeType};base64,${Encoding.encodeBase64(s.bytes)}`),
  Match.exhaustive,
)

const blockToPart = Match.type<ContentBlock>().pipe(
  Match.discriminatorsExhaustive("type")({
    input_text: (b) => ({ type: "text", text: b.text }),
    output_text: (b) => ({ type: "text", text: b.text }),
    refusal: (b) => ({ type: "text", text: b.text }),
    input_image: (b) => ({ type: "image_url", image_url: imageSourceToUrl(b.source) }),
  }),
)

const isTextBlock = (b: ContentBlock): boolean =>
  b.type === "input_text" || b.type === "output_text" || b.type === "refusal"

const textOfBlock = (b: ContentBlock): string => (b.type === "input_image" ? "" : b.text)

/**
 * Collapse a message's content to a plain string when it is text-only
 * (the common case Mistral prefers), otherwise emit the multimodal parts
 * array.
 */
const encodeContent = (
  content: ReadonlyArray<ContentBlock>,
): string | ReadonlyArray<Record<string, unknown>> =>
  Arr.every(content, isTextBlock) ? content.map(textOfBlock).join("") : content.map(blockToPart)

const toolCallWire = (call_id: string, name: string, args: string): Record<string, unknown> => ({
  id: call_id,
  type: "function",
  function: { name, arguments: args },
})

const appendToolCall = (
  acc: ReadonlyArray<WireMessage>,
  call_id: string,
  name: string,
  args: string,
): ReadonlyArray<WireMessage> => {
  const last = acc[acc.length - 1]
  const wire = toolCallWire(call_id, name, args)
  // Attach to the immediately-preceding assistant message (not a tool result),
  // matching the OpenAI/Mistral shape where tool calls ride the assistant turn.
  if (last !== undefined && last.role === "assistant" && last.tool_call_id === undefined) {
    return [...acc.slice(0, -1), { ...last, tool_calls: [...(last.tool_calls ?? []), wire] }]
  }
  return [...acc, { role: "assistant", content: "", tool_calls: [wire] }]
}

const foldItem = (acc: ReadonlyArray<WireMessage>, item: HistoryItem): ReadonlyArray<WireMessage> =>
  Match.value(item).pipe(
    Match.discriminatorsExhaustive("type")({
      message: (m) => [...acc, { role: m.role, content: encodeContent(m.content) }],
      function_call: (f) => appendToolCall(acc, f.call_id, f.name, f.arguments),
      function_call_output: (o) => [
        ...acc,
        { role: "tool", tool_call_id: o.call_id, content: o.output },
      ],
      // Reasoning items are not replayed to the chat-completions endpoint.
      reasoning: () => acc,
    }),
  )

/** Convert our `HistoryItem[]` history into Mistral chat `messages`. */
export const itemsToMessages = (items: ReadonlyArray<HistoryItem>): ReadonlyArray<WireMessage> =>
  Arr.reduce(items, [] as ReadonlyArray<WireMessage>, foldItem)

// ---------------------------------------------------------------------------
// tools / tool_choice / response_format
// ---------------------------------------------------------------------------

export const toolsWire = (
  descriptors: ReadonlyArray<ToolDescriptor>,
): Option.Option<ReadonlyArray<Record<string, unknown>>> =>
  descriptors.length > 0
    ? Option.some(
        descriptors.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            ...(t.strict !== undefined && { strict: t.strict }),
          },
        })),
      )
    : Option.none()

type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { readonly type: "function"; readonly name: string }

// Mistral uses "any" for forced tool use (OpenAI's "required").
export const toolChoiceWire = (choice: ToolChoice): string | Record<string, unknown> =>
  Match.value(choice).pipe(
    Match.when("auto", () => "auto" as const),
    Match.when("required", () => "any" as const),
    Match.when("none", () => "none" as const),
    Match.orElse((c) => ({ type: "function", function: { name: c.name } })),
  )

export const responseFormatWire = (
  structured: StructuredFormat<unknown>,
): Record<string, unknown> => ({
  type: "json_schema",
  json_schema: {
    name: structured.name,
    schema: structured.schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
    ...(structured.strict !== undefined && { strict: structured.strict }),
  },
})

// ---------------------------------------------------------------------------
// Streaming decode: chat.completion.chunk → TurnEvent
// ---------------------------------------------------------------------------

const WireFunction = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  arguments: Schema.optional(Schema.NullOr(Schema.String)),
})

const WireToolCall = Schema.Struct({
  index: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  function: Schema.optional(WireFunction),
})

const WireDelta = Schema.Struct({
  role: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.NullOr(Schema.Array(WireToolCall))),
})

const WireChoice = Schema.Struct({
  index: Schema.optional(Schema.Number),
  delta: Schema.optional(WireDelta),
  finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
})

const WireUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
})

export const WireChunk = Schema.Struct({
  choices: Schema.optional(Schema.Array(WireChoice)),
  usage: Schema.optional(Schema.NullOr(WireUsage)),
})
export type WireChunk = typeof WireChunk.Type

export const decodeChunk = Schema.decodeUnknownEffect(WireChunk)

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

type ToolAcc = {
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

export type Accumulator = {
  readonly text: string
  /** Tool calls keyed by their wire `index` (defaults to position when absent). */
  readonly tools: ReadonlyMap<number, ToolAcc>
  readonly order: ReadonlyArray<number>
  readonly usage: Usage
  readonly finishReason: Option.Option<string>
}

export const emptyAccumulator: Accumulator = {
  text: "",
  tools: new Map(),
  order: [],
  usage: {},
  finishReason: Option.none(),
}

/** State threaded through the fold plus the events the step produced. */
type Step = readonly [Accumulator, ReadonlyArray<TurnEvent>]

const usageFrom = (wire: typeof WireUsage.Type): Usage => ({
  ...(wire.prompt_tokens !== undefined && { input_tokens: wire.prompt_tokens }),
  ...(wire.completion_tokens !== undefined && { output_tokens: wire.completion_tokens }),
  ...(wire.total_tokens !== undefined && { total_tokens: wire.total_tokens }),
})

const reasonToStop = Match.type<string>().pipe(
  Match.when("stop", () => "stop" as const),
  Match.when("length", () => "max_tokens" as const),
  Match.when("model_length", () => "max_tokens" as const),
  Match.when("tool_calls", () => "tool_calls" as const),
  Match.when("content_filter", () => "content_filter" as const),
  Match.orElse(() => "stop" as const),
)

const stopReasonOf = (acc: Accumulator): StopReason =>
  Option.match(acc.finishReason, {
    onNone: () => (acc.tools.size > 0 ? "tool_calls" : "stop"),
    onSome: reasonToStop,
  })

const withTool = (acc: Accumulator, index: number, tool: ToolAcc, isNew: boolean): Accumulator => ({
  ...acc,
  tools: new Map(acc.tools).set(index, tool),
  order: isNew ? [...acc.order, index] : acc.order,
})

const applyContent = (acc: Accumulator, delta: typeof WireDelta.Type | undefined): Step => {
  const content = delta?.content
  return content !== undefined && content !== null && content.length > 0
    ? [{ ...acc, text: acc.text + content }, [TurnEvent.TextDelta({ text: content })]]
    : [acc, []]
}

const applyToolCall = (acc: Accumulator, tc: typeof WireToolCall.Type, position: number): Step => {
  const index = tc.index ?? position
  const argsDelta = tc.function?.arguments ?? ""
  const existing = acc.tools.get(index)
  if (existing === undefined) {
    const call_id = tc.id ?? `call_${index}`
    const name = tc.function?.name ?? ""
    return [
      withTool(acc, index, { call_id, name, arguments: argsDelta }, true),
      [
        TurnEvent.ToolCallStart({ call_id, name }),
        ...(argsDelta.length > 0
          ? [TurnEvent.ToolCallArgsDelta({ call_id, delta: argsDelta })]
          : []),
      ],
    ]
  }
  return argsDelta.length > 0
    ? [
        withTool(acc, index, { ...existing, arguments: existing.arguments + argsDelta }, false),
        [TurnEvent.ToolCallArgsDelta({ call_id: existing.call_id, delta: argsDelta })],
      ]
    : [acc, []]
}

const chain = (step: Step, next: (acc: Accumulator) => Step): Step => {
  const [acc, events] = step
  const [acc2, more] = next(acc)
  return [acc2, [...events, ...more]]
}

const applyChoice = (step: Step, choice: typeof WireChoice.Type): Step => {
  const withContent = chain(step, (acc) => applyContent(acc, choice.delta))
  const withTools = Arr.reduce(choice.delta?.tool_calls ?? [], withContent, (s: Step, tc, i) =>
    chain(s, (acc) => applyToolCall(acc, tc, i)),
  )
  const reason = choice.finish_reason
  return reason !== undefined && reason !== null
    ? [{ ...withTools[0], finishReason: Option.some(reason) }, withTools[1]]
    : withTools
}

/**
 * Fold one decoded chunk into the accumulator, returning the next state and
 * the `TurnEvent`s the chunk produced. Mirrors Anthropic's `deltasFromEvent`,
 * but over chat-completions deltas.
 */
export const applyChunk = (acc: Accumulator, chunk: WireChunk): Step => {
  const afterChoices = Arr.reduce(chunk.choices ?? [], [acc, []] as Step, applyChoice)
  const usage = chunk.usage
  return usage !== undefined && usage !== null
    ? chain(afterChoices, (a) => {
        const u = usageFrom(usage)
        return [{ ...a, usage: u }, [TurnEvent.UsageUpdate({ usage: u })]]
      })
    : afterChoices
}

/** Assemble the terminal `Turn` from the accumulated state. */
export const accumulatorToTurn = (acc: Accumulator): Turn => {
  const message: ReadonlyArray<HistoryItem> =
    acc.text.length > 0
      ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: acc.text }] }]
      : []
  const toolCalls: ReadonlyArray<HistoryItem> = acc.order.flatMap((index) => {
    const t = acc.tools.get(index)
    return t === undefined
      ? []
      : [
          {
            type: "function_call" as const,
            call_id: t.call_id,
            name: t.name,
            arguments: t.arguments,
          },
        ]
  })
  return {
    items: [...message, ...toolCalls],
    usage: acc.usage,
    stop_reason: stopReasonOf(acc),
  }
}
