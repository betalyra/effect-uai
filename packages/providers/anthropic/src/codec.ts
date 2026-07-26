import { Array as Arr, Encoding, Match, Option, Order, Result, Schema, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { JsonParseError } from "@effect-uai/core/JSONL"
import type { Turn } from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Wire schemas - subset of Anthropic Messages API we consume.
// Reference: https://platform.claude.com/docs/en/api/messages
// ---------------------------------------------------------------------------

const WireTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})

const WireToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
})

const WireThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.optional(Schema.String),
})

const WireRedactedThinkingBlock = Schema.Struct({
  type: Schema.Literal("redacted_thinking"),
  data: Schema.String,
})

export const WireContentBlock = Schema.Union([
  WireTextBlock,
  WireToolUseBlock,
  WireThinkingBlock,
  WireRedactedThinkingBlock,
])
export type WireContentBlock = typeof WireContentBlock.Type

const WireUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
})
export type WireUsage = typeof WireUsage.Type

// ---------------------------------------------------------------------------
// History → request body
// ---------------------------------------------------------------------------

type RequestTextContent = {
  readonly type: "text"
  readonly text: string
}

type RequestToolResultContent = {
  readonly type: "tool_result"
  readonly tool_use_id: string
  readonly content: string
}

type RequestToolUseContent = {
  readonly type: "tool_use"
  readonly id: string
  readonly name: string
  readonly input: unknown
}

type RequestThinkingContent = {
  readonly type: "thinking"
  readonly thinking: string
  readonly signature?: string
}

type RequestRedactedThinkingContent = {
  readonly type: "redacted_thinking"
  readonly data: string
}

type RequestImageContent = {
  readonly type: "image"
  readonly source:
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "base64"; readonly media_type: string; readonly data: string }
}

type RequestUserContentBlock = RequestTextContent | RequestToolResultContent | RequestImageContent

type RequestAssistantContentBlock =
  | RequestTextContent
  | RequestToolUseContent
  | RequestThinkingContent
  | RequestRedactedThinkingContent

type RequestUserMessage = {
  readonly role: "user"
  readonly content: ReadonlyArray<RequestUserContentBlock>
}

type RequestAssistantMessage = {
  readonly role: "assistant"
  readonly content: ReadonlyArray<RequestAssistantContentBlock>
}

type RequestMessage = RequestUserMessage | RequestAssistantMessage

const blockText = Match.type<Items.ContentBlock>().pipe(
  Match.discriminatorsExhaustive("type")({
    input_text: (b) => b.text,
    input_image: () => "",
    output_text: (b) => b.text,
    refusal: (b) => b.text,
  }),
)

const messageText = (message: Items.Message): string => message.content.map(blockText).join("")

const imageSourceToWire = Match.type<Items.InputImage["source"]>().pipe(
  Match.tag("url", (s): RequestImageContent["source"] => ({ type: "url", url: s.url })),
  Match.tag("base64", (s): RequestImageContent["source"] => ({
    type: "base64",
    media_type: s.mimeType,
    data: s.base64,
  })),
  Match.tag("bytes", (s): RequestImageContent["source"] => ({
    type: "base64",
    media_type: s.mimeType,
    data: Encoding.encodeBase64(s.bytes),
  })),
  Match.exhaustive,
)

const userContentBlock = (
  block: Items.ContentBlock,
): Result.Result<RequestUserContentBlock, void> =>
  Match.value(block).pipe(
    Match.discriminatorsExhaustive("type")({
      input_text: (b) =>
        b.text.length === 0
          ? Result.failVoid
          : Result.succeed({ type: "text" as const, text: b.text }),
      input_image: (b) =>
        Result.succeed({ type: "image" as const, source: imageSourceToWire(b.source) }),
      // Assistant content; never appears on a user message in practice. Skip.
      output_text: () => Result.failVoid,
      refusal: () => Result.failVoid,
    }),
  )

const parseJson = (s: string): Result.Result<unknown, JsonParseError> =>
  Result.try({
    try: () => JSON.parse(s) as unknown,
    catch: (cause) => new JsonParseError({ line: s, cause }),
  })

type RoleBucket = "user" | "assistant" | "system"

const roleBucket = (item: Items.HistoryItem): RoleBucket =>
  Match.value(item).pipe(
    Match.discriminatorsExhaustive("type")({
      message: (m) => m.role,
      function_call: () => "assistant" as const,
      function_call_output: () => "user" as const,
      reasoning: () => "assistant" as const,
    }),
  )

const itemToUserBlocks = (item: Items.HistoryItem): ReadonlyArray<RequestUserContentBlock> =>
  Match.value(item).pipe(
    Match.discriminatorsExhaustive("type")({
      message: (m): ReadonlyArray<RequestUserContentBlock> =>
        m.role === "user" ? pipe(m.content, Arr.filterMap(userContentBlock)) : [],
      function_call: (): ReadonlyArray<RequestUserContentBlock> => [],
      function_call_output: (o): ReadonlyArray<RequestUserContentBlock> => [
        { type: "tool_result", tool_use_id: o.call_id, content: o.output },
      ],
      reasoning: (): ReadonlyArray<RequestUserContentBlock> => [],
    }),
  )

const itemToAssistantBlocks = (
  item: Items.HistoryItem,
): Result.Result<ReadonlyArray<RequestAssistantContentBlock>, JsonParseError> =>
  Match.value(item).pipe(
    Match.discriminatorsExhaustive("type")({
      message: (m): Result.Result<ReadonlyArray<RequestAssistantContentBlock>, JsonParseError> => {
        const text = messageText(m)
        return Result.succeed(
          m.role === "assistant" && text.length > 0 ? [{ type: "text", text }] : [],
        )
      },
      function_call: (f) =>
        pipe(
          parseJson(f.arguments),
          Result.map(
            (input): ReadonlyArray<RequestAssistantContentBlock> => [
              { type: "tool_use", id: f.call_id, name: f.name, input },
            ],
          ),
        ),
      function_call_output: (): Result.Result<
        ReadonlyArray<RequestAssistantContentBlock>,
        JsonParseError
      > => Result.succeed([]),
      reasoning: (r) => {
        const blocks: ReadonlyArray<RequestAssistantContentBlock> =
          r.summary !== undefined
            ? [
                {
                  type: "thinking",
                  thinking: r.summary,
                  ...(r.signature !== undefined && { signature: r.signature }),
                },
              ]
            : r.signature !== undefined
              ? [{ type: "redacted_thinking", data: r.signature }]
              : []
        return Result.succeed(blocks)
      },
    }),
  )

type GroupAcc = {
  readonly messages: ReadonlyArray<RequestMessage>
  readonly currentRole: Option.Option<"user" | "assistant">
  readonly userBuf: ReadonlyArray<RequestUserContentBlock>
  readonly assistantBuf: ReadonlyArray<RequestAssistantContentBlock>
}

const flushAcc = (acc: GroupAcc): ReadonlyArray<RequestMessage> =>
  Option.match(acc.currentRole, {
    onNone: () => acc.messages,
    onSome: (role) =>
      role === "user" && acc.userBuf.length > 0
        ? [...acc.messages, { role: "user", content: acc.userBuf }]
        : role === "assistant" && acc.assistantBuf.length > 0
          ? [...acc.messages, { role: "assistant", content: acc.assistantBuf }]
          : acc.messages,
  })

const appendUser = (acc: GroupAcc, blocks: ReadonlyArray<RequestUserContentBlock>): GroupAcc =>
  blocks.length === 0
    ? acc
    : Option.isSome(acc.currentRole) && acc.currentRole.value === "user"
      ? { ...acc, userBuf: [...acc.userBuf, ...blocks] }
      : {
          messages: flushAcc(acc),
          currentRole: Option.some("user"),
          userBuf: blocks,
          assistantBuf: [],
        }

const appendAssistant = (
  acc: GroupAcc,
  blocks: ReadonlyArray<RequestAssistantContentBlock>,
): GroupAcc =>
  blocks.length === 0
    ? acc
    : Option.isSome(acc.currentRole) && acc.currentRole.value === "assistant"
      ? { ...acc, assistantBuf: [...acc.assistantBuf, ...blocks] }
      : {
          messages: flushAcc(acc),
          currentRole: Option.some("assistant"),
          userBuf: [],
          assistantBuf: blocks,
        }

const groupStep = (
  acc: GroupAcc,
  item: Items.HistoryItem,
): Result.Result<GroupAcc, JsonParseError> => {
  const bucket = roleBucket(item)
  if (bucket === "system") return Result.succeed(acc)
  if (bucket === "user") {
    return Result.succeed(appendUser(acc, itemToUserBlocks(item)))
  }
  return pipe(
    itemToAssistantBlocks(item),
    Result.map((blocks) => appendAssistant(acc, blocks)),
  )
}

/**
 * Group consecutive same-role items into Anthropic-shaped messages.
 * Anthropic requires strict user/assistant alternation; consecutive items
 * from the same role are folded into one message's `content`. Fails if any
 * `function_call.arguments` is not valid JSON, since Anthropic's wire shape
 * requires an object input.
 */
const groupedMessages = (
  history: ReadonlyArray<Items.HistoryItem>,
): Result.Result<ReadonlyArray<RequestMessage>, JsonParseError> => {
  const initial: Result.Result<GroupAcc, JsonParseError> = Result.succeed({
    messages: [],
    currentRole: Option.none(),
    userBuf: [],
    assistantBuf: [],
  })
  return pipe(
    Arr.reduce(history, initial, (acc, item) => Result.flatMap(acc, (a) => groupStep(a, item))),
    Result.map(flushAcc),
  )
}

const isSystemMessage = (item: Items.HistoryItem): item is Items.Message =>
  item.type === "message" && item.role === "system"

const systemFromHistory = (history: ReadonlyArray<Items.HistoryItem>): Option.Option<string> => {
  const texts = pipe(
    history,
    Arr.filterMap((item) =>
      isSystemMessage(item) ? Result.succeed(messageText(item)) : Result.failVoid,
    ),
    Arr.filter((s) => s.length > 0),
  )
  return texts.length === 0 ? Option.none() : Option.some(texts.join("\n"))
}

export type ThinkingConfig = {
  readonly type: "enabled"
  readonly budget_tokens: number
}

/** Cache lifetime. `1h` writes cost 2x base input; `5m` costs 1.25x. */
export type CacheTtl = "5m" | "1h"

/**
 * Request-level cache breakpoint. Anthropic applies it to the last cacheable
 * block and moves it forward as the conversation grows, so the cached prefix
 * (`tools` → `system` → `messages`) follows the conversation without the
 * caller re-placing anything.
 */
export type CacheControl = {
  readonly type: "ephemeral"
  readonly ttl?: CacheTtl
}

export type RequestBody = {
  readonly model: string
  readonly messages: ReadonlyArray<RequestMessage>
  readonly max_tokens: number
  readonly system?: string
  readonly temperature?: number
  readonly top_p?: number
  readonly top_k?: number
  readonly stop_sequences?: ReadonlyArray<string>
  readonly thinking?: ThinkingConfig
  readonly tools?: ReadonlyArray<Record<string, unknown>>
  readonly tool_choice?: Record<string, unknown>
  readonly metadata?: { readonly user_id: string }
  readonly output_config?: Record<string, unknown>
  readonly cache_control?: CacheControl
  readonly stream: true
}

export const buildRequestBody = (params: {
  readonly model: string
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly maxTokens: number
  readonly temperature: Option.Option<number>
  readonly topP: Option.Option<number>
  readonly topK: Option.Option<number>
  readonly stopSequences: Option.Option<ReadonlyArray<string>>
  readonly thinking: Option.Option<ThinkingConfig>
  readonly tools: Option.Option<ReadonlyArray<Record<string, unknown>>>
  readonly toolChoice: Option.Option<Record<string, unknown>>
  readonly userId: Option.Option<string>
  readonly outputConfig: Option.Option<Record<string, unknown>>
  readonly cacheControl: Option.Option<CacheControl>
}): Result.Result<RequestBody, JsonParseError> =>
  pipe(
    groupedMessages(params.history),
    Result.map(
      (messages): RequestBody => ({
        model: params.model,
        messages,
        max_tokens: params.maxTokens,
        ...Option.match(systemFromHistory(params.history), {
          onNone: () => ({}),
          onSome: (system) => ({ system }),
        }),
        ...Option.match(params.temperature, {
          onNone: () => ({}),
          onSome: (temperature) => ({ temperature }),
        }),
        ...Option.match(params.topP, {
          onNone: () => ({}),
          onSome: (top_p) => ({ top_p }),
        }),
        ...Option.match(params.topK, {
          onNone: () => ({}),
          onSome: (top_k) => ({ top_k }),
        }),
        ...Option.match(params.stopSequences, {
          onNone: () => ({}),
          onSome: (stop_sequences) => ({ stop_sequences }),
        }),
        ...Option.match(params.thinking, {
          onNone: () => ({}),
          onSome: (thinking) => ({ thinking }),
        }),
        ...Option.match(params.tools, {
          onNone: () => ({}),
          onSome: (tools) => ({ tools }),
        }),
        ...Option.match(params.toolChoice, {
          onNone: () => ({}),
          onSome: (tool_choice) => ({ tool_choice }),
        }),
        ...Option.match(params.userId, {
          onNone: () => ({}),
          onSome: (user_id) => ({ metadata: { user_id } }),
        }),
        ...Option.match(params.outputConfig, {
          onNone: () => ({}),
          onSome: (output_config) => ({ output_config }),
        }),
        ...Option.match(params.cacheControl, {
          onNone: () => ({}),
          onSome: (cache_control) => ({ cache_control }),
        }),
        stream: true,
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Stream-level state - assemble content blocks index-by-index, then emit
// our `Items.HistoryItem[]` when `message_stop` lands.
// ---------------------------------------------------------------------------

type BlockBuffer = {
  readonly type: WireContentBlock["type"]
  readonly text: string
  readonly inputJson: string
  readonly thinking: string
  readonly signature: string
  readonly id: Option.Option<string>
  readonly name: Option.Option<string>
  readonly redactedData: Option.Option<string>
}

const emptyBlock = (type: WireContentBlock["type"]): BlockBuffer => ({
  type,
  text: "",
  inputJson: "",
  thinking: "",
  signature: "",
  id: Option.none(),
  name: Option.none(),
  redactedData: Option.none(),
})

export type Accumulator = {
  readonly blocks: Readonly<Record<number, BlockBuffer>>
  readonly stopReason: Option.Option<string>
  readonly usage: Items.Usage
}

export const emptyAccumulator: Accumulator = {
  blocks: {},
  stopReason: Option.none(),
  usage: {},
}

const replaceBlock = (acc: Accumulator, index: number, block: BlockBuffer): Accumulator => ({
  ...acc,
  blocks: { ...acc.blocks, [index]: block },
})

const updateBlock = (
  acc: Accumulator,
  index: number,
  patch: (block: BlockBuffer) => BlockBuffer,
): Accumulator => replaceBlock(acc, index, patch(acc.blocks[index] ?? emptyBlock("text")))

export const startBlock = (acc: Accumulator, index: number, block: WireContentBlock): Accumulator =>
  Match.value(block).pipe(
    Match.discriminatorsExhaustive("type")({
      text: () => replaceBlock(acc, index, emptyBlock("text")),
      tool_use: (b) =>
        replaceBlock(acc, index, {
          ...emptyBlock("tool_use"),
          id: Option.some(b.id),
          name: Option.some(b.name),
          inputJson: typeof b.input === "string" ? b.input : "",
        }),
      thinking: () => replaceBlock(acc, index, emptyBlock("thinking")),
      redacted_thinking: (b) =>
        replaceBlock(acc, index, {
          ...emptyBlock("redacted_thinking"),
          redactedData: Option.some(b.data),
        }),
    }),
  )

export const appendTextDelta = (acc: Accumulator, index: number, text: string): Accumulator =>
  updateBlock(acc, index, (b) => ({ ...b, text: b.text + text }))

export const appendInputJsonDelta = (
  acc: Accumulator,
  index: number,
  partial: string,
): Accumulator => updateBlock(acc, index, (b) => ({ ...b, inputJson: b.inputJson + partial }))

export const appendThinkingDelta = (
  acc: Accumulator,
  index: number,
  thinking: string,
): Accumulator => updateBlock(acc, index, (b) => ({ ...b, thinking: b.thinking + thinking }))

export const appendSignatureDelta = (
  acc: Accumulator,
  index: number,
  signature: string,
): Accumulator => updateBlock(acc, index, (b) => ({ ...b, signature: b.signature + signature }))

export const setStopReason = (acc: Accumulator, reason: string): Accumulator => ({
  ...acc,
  stopReason: Option.some(reason),
})

// Anthropic splits input across three billed buckets: `input_tokens`
// (post-breakpoint), cache reads, and cache writes. All three are kept;
// `input_tokens` is not the input total. Each field carries over from the
// prior value since a streamed turn spreads usage across events (input +
// cache on message_start, output_tokens on message_delta), so total_tokens is
// summed from the accumulated buckets, not one event.
export const mergeUsage = (acc: Accumulator, wire: WireUsage): Accumulator => {
  const prev = acc.usage
  const input_tokens = wire.input_tokens ?? prev.input_tokens
  const output_tokens = wire.output_tokens ?? prev.output_tokens
  const cached_tokens = wire.cache_read_input_tokens ?? prev.input_tokens_details?.cached_tokens
  const cache_write_tokens =
    wire.cache_creation_input_tokens ?? prev.input_tokens_details?.cache_write_tokens

  const buckets = [input_tokens, cached_tokens, cache_write_tokens, output_tokens]
  const total_tokens = buckets.every((v) => v === undefined)
    ? undefined
    : buckets.reduce<number>((sum, v) => sum + (v ?? 0), 0)

  const details: Items.InputTokensDetails = {
    ...(cached_tokens !== undefined && { cached_tokens }),
    ...(cache_write_tokens !== undefined && { cache_write_tokens }),
  }
  const usage: Items.Usage = {
    ...(input_tokens !== undefined && { input_tokens }),
    ...(output_tokens !== undefined && { output_tokens }),
    ...(total_tokens !== undefined && { total_tokens }),
    ...(Object.keys(details).length > 0 && { input_tokens_details: details }),
  }
  return { ...acc, usage }
}

const stopReasonFromAnthropic = (reason: Option.Option<string>): Turn["stop_reason"] =>
  Option.match(reason, {
    onNone: () => "stop" as const,
    onSome: (r) =>
      Match.value(r).pipe(
        Match.when("tool_use", () => "tool_calls" as const),
        Match.when("max_tokens", () => "max_tokens" as const),
        Match.orElse(() => "stop" as const),
      ),
  })

const blocksByIndex = (acc: Accumulator): ReadonlyArray<BlockBuffer> =>
  pipe(
    Object.keys(acc.blocks),
    Arr.map((k) => Number(k)),
    Arr.sort(Order.Number),
    Arr.map((i) => acc.blocks[i]!),
  )

const blockToItems = (block: BlockBuffer): ReadonlyArray<Items.HistoryItem> =>
  Match.value(block.type).pipe(
    Match.when(
      "text",
      (): ReadonlyArray<Items.HistoryItem> =>
        block.text.length === 0
          ? []
          : [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: block.text }],
              },
            ],
    ),
    Match.when(
      "tool_use",
      (): ReadonlyArray<Items.HistoryItem> => [
        {
          type: "function_call",
          call_id: Option.getOrElse(block.id, () => ""),
          name: Option.getOrElse(block.name, () => ""),
          arguments: block.inputJson,
        },
      ],
    ),
    Match.when(
      "thinking",
      (): ReadonlyArray<Items.HistoryItem> => [
        {
          type: "reasoning",
          ...(block.thinking.length > 0 && { summary: block.thinking }),
          ...(block.signature.length > 0 && { signature: block.signature }),
        },
      ],
    ),
    Match.when(
      "redacted_thinking",
      (): ReadonlyArray<Items.HistoryItem> => [
        {
          type: "reasoning",
          ...Option.match(block.redactedData, {
            onNone: () => ({}),
            onSome: (signature) => ({ signature }),
          }),
        },
      ],
    ),
    Match.exhaustive,
  )

type MergeAcc = {
  readonly out: ReadonlyArray<Items.HistoryItem>
}

const mergeStep = (acc: MergeAcc, item: Items.HistoryItem): MergeAcc => {
  const last = Arr.last(acc.out)
  if (
    Option.isSome(last) &&
    last.value.type === "message" &&
    last.value.role === "assistant" &&
    item.type === "message" &&
    item.role === "assistant"
  ) {
    const merged: Items.Message = {
      ...last.value,
      content: [...last.value.content, ...item.content],
    }
    return { out: [...acc.out.slice(0, -1), merged] }
  }
  return { out: [...acc.out, item] }
}

const mergeAdjacentAssistantText = (
  items: ReadonlyArray<Items.HistoryItem>,
): ReadonlyArray<Items.HistoryItem> => Arr.reduce(items, { out: [] } as MergeAcc, mergeStep).out

export const accumulatorToTurn = (acc: Accumulator): Turn => ({
  items: pipe(blocksByIndex(acc), Arr.flatMap(blockToItems), mergeAdjacentAssistantText),
  usage: acc.usage,
  stop_reason: stopReasonFromAnthropic(acc.stopReason),
})
