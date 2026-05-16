import { Array as Arr, Encoding, Match, Option, Result, Schema, pipe } from "effect"
import type { ContentBlock, FunctionCall, InputImage, Item, Message } from "@effect-uai/core/Items"
import type { ToolDescriptor } from "@effect-uai/core/Tool"
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

/**
 * Gemini function-call part. Args are delivered as a whole JSON *object*
 * in a single chunk (Gemini does not stream tool-call args). On Gemini 3
 * the response also carries an `id` per call, which we echo back on the
 * corresponding `functionResponse`.
 */
const FunctionCallPart = Schema.Struct({
  functionCall: Schema.Struct({
    id: Schema.optional(Schema.String),
    name: Schema.String,
    args: Schema.optional(Schema.Unknown),
  }),
})

const Part = Schema.Union([TextPart, FunctionCallPart])
type WireFunctionCallPart = typeof FunctionCallPart.Type

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
  | { readonly functionCall: { readonly name: string; readonly args: unknown } }
  | {
      readonly functionResponse: {
        readonly name: string
        readonly response: Record<string, unknown>
      }
    }

type RequestContent = {
  readonly role: "user" | "model"
  readonly parts: ReadonlyArray<RequestPart>
}

type RequestSystemInstruction = {
  readonly parts: ReadonlyArray<{ readonly text: string }>
}

/** Gemini's tool declaration. We translate one `ToolDescriptor` per entry. */
type RequestTool = {
  readonly functionDeclarations: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }>
}

type RequestToolConfig = {
  readonly functionCallingConfig: {
    readonly mode: "AUTO" | "ANY" | "NONE"
    readonly allowedFunctionNames?: ReadonlyArray<string>
  }
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
  readonly tools?: ReadonlyArray<RequestTool>
  readonly toolConfig?: RequestToolConfig
}

const blockText = Match.type<ContentBlock>().pipe(
  Match.discriminatorsExhaustive("type")({
    input_text: (b) => b.text,
    input_image: () => "",
    output_text: (b) => b.text,
    refusal: (b) => b.text,
  }),
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
    (s): ReadonlyArray<RequestPart> => [{ inlineData: { mimeType: s.mimeType, data: s.base64 } }],
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
  Match.discriminatorsExhaustive("type")({
    input_text: (b): ReadonlyArray<RequestPart> => (b.text.length === 0 ? [] : [{ text: b.text }]),
    input_image: (b): ReadonlyArray<RequestPart> => imageSourceToParts(b.source),
    output_text: (b): ReadonlyArray<RequestPart> => (b.text.length === 0 ? [] : [{ text: b.text }]),
    // Refusals are assistant-side content; they don't round-trip into Gemini's
    // request body as parts. Skip.
    refusal: (): ReadonlyArray<RequestPart> => [],
  }),
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

const allMessages = (history: ReadonlyArray<Item>): ReadonlyArray<Message> =>
  pipe(
    history,
    Arr.filterMap((item) => (item.type === "message" ? Result.succeed(item) : Result.failVoid)),
  )

// ---------------------------------------------------------------------------
// Function-call round-trip
//
// `FunctionCall` items carry JSON-encoded `arguments`; Gemini expects a
// parsed object. We decode via Schema, falling back to `{}` for malformed
// payloads so a single bad arg-string doesn't kill the request.
// ---------------------------------------------------------------------------

const parsedArgs = (encoded: string): unknown =>
  pipe(
    Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(encoded),
    Result.match({
      onSuccess: (v) => v,
      onFailure: () => ({}),
    }),
  )

const parsedResponse = (encoded: string): Record<string, unknown> => {
  const decoded = parsedArgs(encoded)
  return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)
    : { output: encoded }
}

/**
 * `FunctionCallOutput` only carries `call_id`; Gemini's `functionResponse`
 * requires the declared function `name`. Resolve the name by scanning prior
 * `function_call` items in the history for a matching `call_id`. If we
 * cannot resolve, fall back to `call_id` as the name - imperfect but
 * preserves stream shape so the model sees *some* response.
 */
const nameForCallId = (history: ReadonlyArray<Item>, call_id: string): Option.Option<string> =>
  pipe(
    history,
    Arr.findFirst((item) => item.type === "function_call" && item.call_id === call_id),
    Option.flatMap((item) =>
      item.type === "function_call" ? Option.some(item.name) : Option.none(),
    ),
  )

const providerIdFor = (item: FunctionCall): Option.Option<string> => {
  const data = item.providerData
  if (data === undefined || typeof data !== "object") return Option.none()
  const gemini = (data as Record<string, unknown>)["gemini"]
  if (gemini === undefined || typeof gemini !== "object" || gemini === null) return Option.none()
  const id = (gemini as Record<string, unknown>)["id"]
  return typeof id === "string" ? Option.some(id) : Option.none()
}

const itemToContent =
  (history: ReadonlyArray<Item>) =>
  (item: Item): Result.Result<RequestContent, void> =>
    Match.value(item).pipe(
      Match.discriminatorsExhaustive("type")({
        message: messageToContent,
        function_call: (f) =>
          Result.succeed({
            role: "model" as const,
            parts: [
              {
                functionCall: {
                  ...Option.match(providerIdFor(f), {
                    onSome: (id) => ({ id }),
                    onNone: () => ({}),
                  }),
                  name: f.name,
                  args: parsedArgs(f.arguments),
                },
              },
            ],
          }),
        function_call_output: (o) =>
          Result.succeed({
            role: "user" as const,
            parts: [
              {
                functionResponse: {
                  name: Option.getOrElse(nameForCallId(history, o.call_id), () => o.call_id),
                  response: parsedResponse(o.output),
                },
              },
            ],
          }),
        reasoning: () => Result.failVoid,
      }),
    )

// ---------------------------------------------------------------------------
// Tool descriptors → Gemini `functionDeclarations`. Gemini accepts only a
// strict OpenAPI 3.0 subset for `parameters`; strip JSON-Schema keys it
// rejects (`$schema`, `$ref`, `additionalProperties`, `oneOf`,
// `definitions`).
// ---------------------------------------------------------------------------

const UNSUPPORTED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "oneOf",
])

const sanitizeSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  if (schema === null || typeof schema !== "object") return schema
  return pipe(
    Object.entries(schema as Record<string, unknown>),
    Arr.filterMap(([k, v]) =>
      UNSUPPORTED_SCHEMA_KEYS.has(k)
        ? Result.failVoid
        : Result.succeed([k, sanitizeSchema(v)] as const),
    ),
    Object.fromEntries,
  )
}

const toolDescriptorsToTools = (tools: ReadonlyArray<ToolDescriptor>): ReadonlyArray<RequestTool> =>
  tools.length === 0
    ? []
    : [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeSchema(t.inputSchema) as Record<string, unknown>,
          })),
        },
      ]

export const buildRequestBody = (
  history: ReadonlyArray<Item>,
  generationConfig: Option.Option<GenerationConfig>,
  tools: ReadonlyArray<ToolDescriptor> = [],
): RequestBody => {
  const systemTexts = pipe(allMessages(history), Arr.filterMap(systemMessageText))
  const contents = pipe(history, Arr.filterMap(itemToContent(history)))
  const requestTools = toolDescriptorsToTools(tools)
  return {
    contents,
    ...(systemTexts.length > 0 && {
      systemInstruction: { parts: [{ text: systemTexts.join("\n") }] },
    }),
    ...Option.match(generationConfig, {
      onNone: () => ({}),
      onSome: (cfg) => ({ generationConfig: cfg }),
    }),
    ...(requestTools.length > 0 && {
      tools: requestTools,
      toolConfig: { functionCallingConfig: { mode: "AUTO" as const } },
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

export type AccumulatedFunctionCall = {
  /** Synthesized id-or-name we surface as `call_id` on the canonical item. */
  readonly callId: string
  readonly name: string
  /** Wire id from Gemini 3, when present - echoed back on `functionResponse`. */
  readonly providerId: Option.Option<string>
  /** Args as JSON-encoded string, mirroring `Items.FunctionCall.arguments`. */
  readonly arguments: string
}

export type Accumulator = {
  readonly text: string
  readonly reasoning: string
  readonly functionCalls: ReadonlyArray<AccumulatedFunctionCall>
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
  functionCalls: [],
  finishReason: Option.none(),
  usage: {},
}

/**
 * One part's worth of streamable output. `text` and `reasoning` are
 * incremental string deltas; `function_call` arrives whole-in-one-chunk
 * (Gemini does not stream tool-call args).
 */
export type ChunkPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "function_call"
      readonly id: Option.Option<string>
      readonly name: string
      readonly args: unknown
    }

export type ChunkResult = {
  readonly accumulator: Accumulator
  readonly parts: ReadonlyArray<ChunkPart>
  readonly finished: boolean
}

const isTextPart = (p: typeof Part.Type): p is typeof TextPart.Type => "text" in p

const textToChunkParts = (p: typeof TextPart.Type): ReadonlyArray<ChunkPart> =>
  p.text.length === 0 ? [] : [{ kind: p.thought === true ? "reasoning" : "text", text: p.text }]

const functionCallToChunkParts = (p: WireFunctionCallPart): ReadonlyArray<ChunkPart> => [
  {
    kind: "function_call",
    id: Option.fromNullishOr(p.functionCall.id),
    name: p.functionCall.name,
    args: p.functionCall.args ?? {},
  },
]

const partToChunkParts = (p: typeof Part.Type): ReadonlyArray<ChunkPart> =>
  isTextPart(p) ? textToChunkParts(p) : functionCallToChunkParts(p)

const chunkParts = (chunk: WireChunk): ReadonlyArray<ChunkPart> =>
  pipe(chunk.candidates?.[0]?.content?.parts ?? [], Arr.flatMap(partToChunkParts))

const sumStrings = (parts: ReadonlyArray<ChunkPart>, kind: "text" | "reasoning"): string =>
  pipe(
    parts,
    Arr.filterMap((p) =>
      (p.kind === "text" || p.kind === "reasoning") && p.kind === kind
        ? Result.succeed(p.text)
        : Result.failVoid,
    ),
  ).join("")

const collectFunctionCalls = (
  parts: ReadonlyArray<ChunkPart>,
): ReadonlyArray<Extract<ChunkPart, { kind: "function_call" }>> =>
  pipe(
    parts,
    Arr.filterMap((p) => (p.kind === "function_call" ? Result.succeed(p) : Result.failVoid)),
  )

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

/**
 * Synthesize a stable `call_id` for a function call. Gemini 3 provides one
 * via `functionCall.id`; older models do not, so we fall back to
 * `<name>_<index>` based on prior calls' position in the accumulator.
 */
const synthesizeCallId = (
  call: Extract<ChunkPart, { kind: "function_call" }>,
  priorCalls: ReadonlyArray<AccumulatedFunctionCall>,
): string =>
  Option.match(call.id, {
    onSome: (id) => id,
    onNone: () => `${call.name}_${priorCalls.length}`,
  })

const chunkCallToAccumulated = (
  prior: ReadonlyArray<AccumulatedFunctionCall>,
  call: Extract<ChunkPart, { kind: "function_call" }>,
): AccumulatedFunctionCall => ({
  callId: synthesizeCallId(call, prior),
  name: call.name,
  providerId: call.id,
  arguments: JSON.stringify(call.args ?? {}),
})

const appendFunctionCalls = (
  prior: ReadonlyArray<AccumulatedFunctionCall>,
  fromChunk: ReadonlyArray<Extract<ChunkPart, { kind: "function_call" }>>,
): ReadonlyArray<AccumulatedFunctionCall> =>
  fromChunk.reduce<ReadonlyArray<AccumulatedFunctionCall>>(
    (acc, call) => [...acc, chunkCallToAccumulated(acc, call)],
    prior,
  )

export const ingestChunk = (acc: Accumulator, chunk: WireChunk): ChunkResult => {
  const parts = chunkParts(chunk)
  const finishReason = Option.fromNullishOr(chunk.candidates?.[0]?.finishReason)
  return {
    parts,
    finished: Option.isSome(finishReason),
    accumulator: {
      text: acc.text + sumStrings(parts, "text"),
      reasoning: acc.reasoning + sumStrings(parts, "reasoning"),
      functionCalls: appendFunctionCalls(acc.functionCalls, collectFunctionCalls(parts)),
      finishReason: Option.orElse(finishReason, () => acc.finishReason),
      usage: mergeUsage(acc.usage, chunk.usageMetadata),
    },
  }
}

const reasoningItems = (acc: Accumulator): ReadonlyArray<Item> =>
  acc.reasoning.length > 0 ? [{ type: "reasoning", summary: acc.reasoning }] : []

const assistantMessageItems = (acc: Accumulator): ReadonlyArray<Item> =>
  acc.text.length === 0
    ? []
    : [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: acc.text }],
        },
      ]

const functionCallItems = (acc: Accumulator): ReadonlyArray<Item> =>
  pipe(
    acc.functionCalls,
    Arr.map((c) => ({
      type: "function_call" as const,
      call_id: c.callId,
      name: c.name,
      arguments: c.arguments,
      ...(Option.isSome(c.providerId) && { providerData: { gemini: { id: c.providerId.value } } }),
    })),
  )

export const accumulatorToTurn = (acc: Accumulator): Turn => ({
  stop_reason:
    acc.functionCalls.length > 0 ? ("tool_calls" as const) : finishReasonToStop(acc.finishReason),
  usage: { ...acc.usage },
  items: [...reasoningItems(acc), ...assistantMessageItems(acc), ...functionCallItems(acc)],
})
