import { Array as Arr, Match, Option, Result, Schema, pipe } from "effect"
import type { ContentBlock, Item, Message } from "@effect-uai/core/Items"
import { matchType } from "@effect-uai/core/Match"
import type { Turn } from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Wire schemas - the subset of Gemini's streamGenerateContent payload we
// consume. Reference: https://ai.google.dev/api/generate-content
// ---------------------------------------------------------------------------

const TextPart = Schema.Struct({
  text: Schema.String,
  /**
   * Gemini's flag for chain-of-thought parts. When `true`, the part is
   * reasoning trace, not the model's user-facing answer. Maps onto
   * `reasoning_delta { kind: "trace" }` in the canonical view.
   */
  thought: Schema.optional(Schema.Boolean),
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
  cachedContentTokenCount: Schema.optional(Schema.Number),
  thoughtsTokenCount: Schema.optional(Schema.Number),
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
  readonly topP?: number
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
  readonly reasoning: string
  readonly finishReason: Option.Option<string>
  readonly usage: {
    readonly input_tokens?: number
    readonly output_tokens?: number
    readonly total_tokens?: number
    readonly input_tokens_details?: { readonly cached_tokens?: number }
    readonly output_tokens_details?: { readonly reasoning_tokens?: number }
  }
}

export const emptyAccumulator: Accumulator = {
  text: "",
  reasoning: "",
  finishReason: Option.none(),
  usage: {},
}

/**
 * One part's worth of streamable text: either the model's answer
 * (`kind: "text"`) or chain-of-thought (`kind: "reasoning"`). Emitted
 * in wire order so consumers can interleave faithfully.
 */
export type ChunkPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }

export interface ChunkResult {
  readonly accumulator: Accumulator
  readonly parts: ReadonlyArray<ChunkPart>
  readonly finished: boolean
}

const chunkParts = (chunk: WireChunk): ReadonlyArray<ChunkPart> =>
  pipe(
    chunk.candidates?.[0]?.content?.parts ?? [],
    Arr.filterMap((p) =>
      p.text.length === 0
        ? Result.failVoid
        : Result.succeed({
            kind: p.thought === true ? ("reasoning" as const) : ("text" as const),
            text: p.text,
          }),
    ),
  )

const sumByKind = (parts: ReadonlyArray<ChunkPart>, kind: ChunkPart["kind"]): string =>
  pipe(
    parts,
    Arr.filterMap((p) => (p.kind === kind ? Result.succeed(p.text) : Result.failVoid)),
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
        ...(next.cachedContentTokenCount !== undefined && {
          input_tokens_details: { cached_tokens: next.cachedContentTokenCount },
        }),
        ...(next.thoughtsTokenCount !== undefined && {
          output_tokens_details: { reasoning_tokens: next.thoughtsTokenCount },
        }),
      }

export const ingestChunk = (acc: Accumulator, chunk: WireChunk): ChunkResult => {
  const parts = chunkParts(chunk)
  const finishReason = Option.fromNullishOr(chunk.candidates?.[0]?.finishReason)
  return {
    parts,
    finished: Option.isSome(finishReason),
    accumulator: {
      text: acc.text + sumByKind(parts, "text"),
      reasoning: acc.reasoning + sumByKind(parts, "reasoning"),
      finishReason: Option.orElse(finishReason, () => acc.finishReason),
      usage: mergeUsage(acc.usage, chunk.usageMetadata),
    },
  }
}

export const accumulatorToTurn = (acc: Accumulator): Turn => ({
  stop_reason: finishReasonToStop(acc.finishReason),
  usage: { ...acc.usage },
  items: [
    ...(acc.reasoning.length > 0
      ? [{ type: "reasoning" as const, summary: acc.reasoning }]
      : []),
    ...(acc.text.length === 0
      ? []
      : [
          {
            type: "message" as const,
            role: "assistant" as const,
            content: [{ type: "output_text" as const, text: acc.text }],
          },
        ]),
  ],
})
