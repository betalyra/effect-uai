import { Array as Arr, Encoding, Match, Option, Result, Schema, pipe } from "effect"
import type { ContentBlock, InputImage, Item, Message } from "@effect-uai/core/Items"
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

type RequestPart =
  | { readonly text: string }
  | { readonly inlineData: { readonly mimeType: string; readonly data: string } }

type RequestContent = {
  readonly role: "user" | "model"
  readonly parts: ReadonlyArray<RequestPart>
}

type RequestSystemInstruction = {
  readonly parts: ReadonlyArray<{ readonly text: string }>
}

export type ThinkingConfig = {
  readonly thinkingBudget: number
}

export type GenerationConfig = {
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly topP?: number
  readonly thinkingConfig?: ThinkingConfig
  /** Set together with `responseJsonSchema` to constrain output to JSON. */
  readonly responseMimeType?: string
  /** JSON Schema constraint on the output. */
  readonly responseJsonSchema?: Record<string, unknown>
}

export type RequestBody = {
  readonly contents: ReadonlyArray<RequestContent>
  readonly systemInstruction?: RequestSystemInstruction
  readonly generationConfig?: GenerationConfig
}

const blockText = Match.type<ContentBlock>().pipe(
  matchType("input_text", (b) => b.text),
  matchType("input_image", () => ""),
  matchType("output_text", (b) => b.text),
  matchType("refusal", (b) => b.text),
  Match.exhaustive,
)

const messageText = (message: Message): string => message.content.map(blockText).join("")

/**
 * Gemini's `inlineData` form expects a base64 payload. URL-form images
 * would need to go through Gemini's Files API (upload then `fileData`
 * with the returned URI); pre-uploading isn't free, so we skip those for
 * now and document as a follow-up.
 */
const imageSourceToParts = Match.type<InputImage["source"]>().pipe(
  Match.tag("url", (): ReadonlyArray<RequestPart> => []),
  Match.tag(
    "base64",
    (s): ReadonlyArray<RequestPart> => [
      { inlineData: { mimeType: s.mimeType, data: s.base64 } },
    ],
  ),
  Match.tag(
    "bytes",
    (s): ReadonlyArray<RequestPart> => [
      { inlineData: { mimeType: s.mimeType, data: Encoding.encodeBase64(s.bytes) } },
    ],
  ),
  Match.exhaustive,
)

const blockToParts = Match.type<ContentBlock>().pipe(
  matchType(
    "input_text",
    (b): ReadonlyArray<RequestPart> => (b.text.length === 0 ? [] : [{ text: b.text }]),
  ),
  matchType("input_image", (b): ReadonlyArray<RequestPart> => imageSourceToParts(b.source)),
  matchType(
    "output_text",
    (b): ReadonlyArray<RequestPart> => (b.text.length === 0 ? [] : [{ text: b.text }]),
  ),
  // Refusals are assistant-side content; they don't round-trip into Gemini's
  // request body as parts. Skip.
  matchType("refusal", (): ReadonlyArray<RequestPart> => []),
  Match.exhaustive,
)

const messageToContent = (message: Message): Result.Result<RequestContent, void> => {
  const parts = pipe(message.content, Arr.flatMap(blockToParts))
  if (parts.length === 0) return Result.failVoid
  return Match.value(message.role).pipe(
    Match.when("user", () => Result.succeed({ role: "user" as const, parts })),
    Match.when("assistant", () => Result.succeed({ role: "model" as const, parts })),
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

export type Accumulator = {
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

export type ChunkResult = {
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
    ...(acc.reasoning.length > 0 ? [{ type: "reasoning" as const, summary: acc.reasoning }] : []),
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
