import { Array as Arr, Match, Option, Result, Schema, pipe } from "effect"
import type { ContentBlock, Item, Message } from "@betalyra/effect-uai-core/Items"
import { matchType } from "@betalyra/effect-uai-core/Match"
import type { Turn } from "@betalyra/effect-uai-core/Turn"

// ---------------------------------------------------------------------------
// Wire schemas - the subset of Gemini's streamGenerateContent payload we
// consume. Reference: https://ai.google.dev/api/generate-content
// ---------------------------------------------------------------------------

const TextPart = Schema.Struct({
  text: Schema.String,
})

const Part = Schema.Union([TextPart])

const Content = Schema.Struct({
  role: Schema.optional(Schema.String),
  parts: Schema.optional(Schema.Array(Part)),
})

const Candidate = Schema.Struct({
  content: Schema.optional(Content),
  finishReason: Schema.optional(Schema.String),
  index: Schema.optional(Schema.Number),
})

const UsageMetadata = Schema.Struct({
  promptTokenCount: Schema.optional(Schema.Number),
  candidatesTokenCount: Schema.optional(Schema.Number),
  totalTokenCount: Schema.optional(Schema.Number),
})

export const WireChunk = Schema.Struct({
  candidates: Schema.optional(Schema.Array(Candidate)),
  usageMetadata: Schema.optional(UsageMetadata),
})
export type WireChunk = typeof WireChunk.Type

// ---------------------------------------------------------------------------
// History → request body
// ---------------------------------------------------------------------------

interface RequestContent {
  readonly role: "user" | "model"
  readonly parts: ReadonlyArray<{ readonly text: string }>
}

interface RequestSystemInstruction {
  readonly parts: ReadonlyArray<{ readonly text: string }>
}

export interface ThinkingConfig {
  readonly thinkingBudget: number
}

export interface GenerationConfig {
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly thinkingConfig?: ThinkingConfig
}

export interface RequestBody {
  readonly contents: ReadonlyArray<RequestContent>
  readonly systemInstruction?: RequestSystemInstruction
  readonly generationConfig?: GenerationConfig
}

const blockText = Match.type<ContentBlock>().pipe(
  matchType("input_text", (b) => b.text),
  matchType("output_text", (b) => b.text),
  Match.exhaustive,
)

const messageText = (message: Message): string => message.content.map(blockText).join("")

const userContent = (text: string): RequestContent => ({ role: "user", parts: [{ text }] })
const modelContent = (text: string): RequestContent => ({ role: "model", parts: [{ text }] })

const messageToContent = (message: Message): Result.Result<RequestContent, void> => {
  const text = messageText(message)
  if (text.length === 0) return Result.failVoid
  return Match.value(message.role).pipe(
    Match.when("user", () => Result.succeed(userContent(text))),
    Match.when("assistant", () => Result.succeed(modelContent(text))),
    Match.when("system", () => Result.failVoid),
    Match.exhaustive,
  )
}

const systemMessageText = (message: Message): Result.Result<string, void> => {
  if (message.role !== "system") return Result.failVoid
  const text = messageText(message)
  return text.length === 0 ? Result.failVoid : Result.succeed(text)
}

const messages = (history: ReadonlyArray<Item>): ReadonlyArray<Message> =>
  pipe(
    history,
    Arr.filterMap((item) => (item.type === "message" ? Result.succeed(item) : Result.failVoid)),
  )

export const buildRequestBody = (
  history: ReadonlyArray<Item>,
  generationConfig: Option.Option<GenerationConfig>,
): RequestBody => {
  const msgs = messages(history)
  const systemTexts = pipe(msgs, Arr.filterMap(systemMessageText))
  const contents = pipe(msgs, Arr.filterMap(messageToContent))
  return {
    contents,
    ...(systemTexts.length > 0 && {
      systemInstruction: { parts: [{ text: systemTexts.join("\n") }] },
    }),
    ...Option.match(generationConfig, {
      onNone: () => ({}),
      onSome: (cfg) => ({ generationConfig: cfg }),
    }),
  }
}

// ---------------------------------------------------------------------------
// Stream-level state - accumulate chunk text + final usage/finish.
//
// `Accumulator` is immutable; `ingestChunk` returns a fresh one per chunk.
// Drive it via `Stream.mapAccum` in the consumer.
// ---------------------------------------------------------------------------

const finishReasonToStop = (reason: Option.Option<string>): Turn["stop_reason"] =>
  Option.match(reason, {
    onNone: () => "stop" as const,
    onSome: (r) => (r === "MAX_TOKENS" ? ("max_tokens" as const) : ("stop" as const)),
  })

export interface Accumulator {
  readonly text: string
  readonly finishReason: Option.Option<string>
  readonly usage: {
    readonly input_tokens?: number
    readonly output_tokens?: number
    readonly total_tokens?: number
  }
}

export const emptyAccumulator: Accumulator = {
  text: "",
  finishReason: Option.none(),
  usage: {},
}

export interface ChunkResult {
  readonly accumulator: Accumulator
  readonly chunkText: string
  readonly finished: boolean
}

const chunkText = (chunk: WireChunk): string =>
  pipe(
    chunk.candidates?.[0]?.content?.parts ?? [],
    Arr.map((p) => p.text),
  ).join("")

const mergeUsage = (
  prev: Accumulator["usage"],
  next: WireChunk["usageMetadata"],
): Accumulator["usage"] =>
  next === undefined
    ? prev
    : {
        ...prev,
        ...(next.promptTokenCount !== undefined && { input_tokens: next.promptTokenCount }),
        ...(next.candidatesTokenCount !== undefined && {
          output_tokens: next.candidatesTokenCount,
        }),
        ...(next.totalTokenCount !== undefined && { total_tokens: next.totalTokenCount }),
      }

export const ingestChunk = (acc: Accumulator, chunk: WireChunk): ChunkResult => {
  const text = chunkText(chunk)
  const finishReason = Option.fromNullishOr(chunk.candidates?.[0]?.finishReason)
  return {
    chunkText: text,
    finished: Option.isSome(finishReason),
    accumulator: {
      text: acc.text + text,
      finishReason: Option.orElse(finishReason, () => acc.finishReason),
      usage: mergeUsage(acc.usage, chunk.usageMetadata),
    },
  }
}

export const accumulatorToTurn = (acc: Accumulator): Turn => ({
  stop_reason: finishReasonToStop(acc.finishReason),
  usage: { ...acc.usage },
  items:
    acc.text.length === 0
      ? []
      : [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: acc.text }],
          },
        ],
})
