import { Array as Arr, Encoding, Match, Option, Result, Schema, pipe } from "effect"
import type {
  ContentBlock,
  ToolCall,
  InputImage,
  HistoryItem,
  Message,
  Annotation,
} from "@effect-uai/core/Items"
import type { ToolDescriptor } from "@effect-uai/core/Tool"
import type { Turn } from "@effect-uai/core/Turn"
import type { CommonRequest } from "@effect-uai/core/LanguageModel"

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
  // Gemini 3 thinking models attach an opaque signature to each function-call
  // part that must be replayed on the next request, or the call is rejected.
  thoughtSignature: Schema.optional(Schema.String),
})

const Part = Schema.Union([TextPart, FunctionCallPart])
type WireFunctionCallPart = typeof FunctionCallPart.Type

const Content = Schema.Struct({
  role: Schema.optional(Schema.String),
  parts: Schema.optional(Schema.Array(Part)),
})

// Google grounding metadata. On a grounded response the candidate carries
// `groundingChunks[].web.{uri,title}` - the structured form of the inline `[n]`
// / trailing `**Sources:**` list the model renders into the answer text.
// Decoded defensively (every field optional) as it is absent on ungrounded
// turns. Shared with the Interactions deep-research surface via `codec.ts`.
const GroundingChunk = Schema.Struct({
  web: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        uri: Schema.optional(Schema.NullOr(Schema.String)),
        title: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
export const GroundingMetadata = Schema.Struct({
  groundingChunks: Schema.optional(Schema.NullOr(Schema.Array(GroundingChunk))),
})
export type GroundingMetadata = typeof GroundingMetadata.Type

// Two citations are the same source when they point at the same url.
const sameUrlCitation = (a: Annotation, b: Annotation): boolean =>
  a.type === "url_citation" && b.type === "url_citation" && a.url === b.url

// Grounding chunks → `url_citation` annotations, de-duped by url across every
// metadata block passed. `web.uri` is a `grounding-api-redirect` URL and
// `web.title` the bare domain; both are kept as-is (the redirect resolves to
// the real page).
export const groundingToAnnotations = (
  ...metas: ReadonlyArray<GroundingMetadata | null | undefined>
): ReadonlyArray<Annotation> =>
  pipe(
    metas,
    Arr.flatMap((meta) => meta?.groundingChunks ?? []),
    Arr.filterMap((chunk) =>
      chunk.web?.uri == null
        ? Result.failVoid
        : Result.succeed<Annotation>({
            type: "url_citation",
            url: chunk.web.uri,
            title: chunk.web.title ?? chunk.web.uri,
          }),
    ),
    Arr.dedupeWith(sameUrlCitation),
  )

const Candidate = Schema.Struct({
  content: Schema.optional(Content),
  groundingMetadata: Schema.optional(GroundingMetadata),
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
  | {
      readonly functionCall: {
        readonly id?: string
        readonly name: string
        readonly args: unknown
      }
      readonly thoughtSignature?: string
    }
  | {
      readonly functionResponse: {
        readonly id?: string
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

/**
 * Gemini's tool declaration. A `tools[]` entry is either a function-declaration
 * block (translated from `ToolDescriptor`s) or one of the native hosted-tool
 * entries. The native entries are empty objects keyed camelCase per the REST
 * v1beta `Tool` object, and sit as siblings of the declarations in the same
 * `tools` array.
 */
export type RequestTool =
  | {
      readonly functionDeclarations: ReadonlyArray<{
        readonly name: string
        readonly description: string
        readonly parameters: Record<string, unknown>
      }>
    }
  | { readonly googleSearch: {} }
  | { readonly urlContext: {} }
  | { readonly codeExecution: {} }

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
  Match.tag("base64", (s): ReadonlyArray<RequestPart> => [
    { inlineData: { mimeType: s.mimeType, data: s.base64 } },
  ]),
  Match.tag("bytes", (s): ReadonlyArray<RequestPart> => [
    { inlineData: { mimeType: s.mimeType, data: Encoding.encodeBase64(s.bytes) } },
  ]),
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

const allMessages = (history: ReadonlyArray<HistoryItem>): ReadonlyArray<Message> =>
  pipe(
    history,
    Arr.filterMap((item) => (item.type === "message" ? Result.succeed(item) : Result.failVoid)),
  )

// ---------------------------------------------------------------------------
// Function-call round-trip
//
// `ToolCall.arguments` and `ToolCallOutput.output` are JSON-encoded
// strings; Gemini's `functionCall.args` and `functionResponse.response`
// expect parsed JSON *objects*. Decode via Schema:
//   - object payload → use as-is
//   - scalar / array / malformed → wrap as `{ output: <raw string> }` so the
//     model still sees *some* response without crashing the request.
// ---------------------------------------------------------------------------

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const decodeJsonObject = Schema.decodeResult(Schema.fromJsonString(JsonObject))

const parsedJsonObject =
  (fallback: (raw: string) => Record<string, unknown>) =>
  (encoded: string): Record<string, unknown> =>
    pipe(
      decodeJsonObject(encoded),
      Result.match({
        onSuccess: (v) => v,
        onFailure: () => fallback(encoded),
      }),
    )

const parsedArgs = parsedJsonObject(() => ({}))
const parsedResponse = parsedJsonObject((raw) => ({ output: raw }))

/**
 * `ToolCallOutput` only carries `call_id`; Gemini's `functionResponse`
 * requires the declared function `name`. Resolve the name by scanning prior
 * `function_call` items in the history for a matching `call_id`. If we
 * cannot resolve, fall back to `call_id` as the name - imperfect but
 * preserves stream shape so the model sees *some* response.
 */
const isFunctionCallItem = (item: HistoryItem): item is ToolCall => item.type === "function_call"

const nameForCallId = (
  history: ReadonlyArray<HistoryItem>,
  call_id: string,
): Option.Option<string> =>
  pipe(
    history,
    Arr.findFirst((item): item is ToolCall => isFunctionCallItem(item) && item.call_id === call_id),
    Option.map((f) => f.name),
  )

/**
 * Extract the Gemini-3 wire id and thought signature we stashed in
 * `providerData` on the way out. Schema-driven so the shape lives in one
 * place; failure or absence → `Option.none()`.
 */
const ProviderDataGemini = Schema.Struct({
  gemini: Schema.Struct({
    id: Schema.optional(Schema.String),
    thoughtSignature: Schema.optional(Schema.String),
  }),
})
const decodeGemini = Schema.decodeUnknownResult(ProviderDataGemini)

const geminiField = (
  item: ToolCall,
  pick: (g: {
    readonly id?: string | undefined
    readonly thoughtSignature?: string | undefined
  }) => string | undefined,
): Option.Option<string> =>
  pipe(
    decodeGemini(item.providerData),
    Result.match({
      onSuccess: (d) => Option.fromNullishOr(pick(d.gemini)),
      onFailure: () => Option.none<string>(),
    }),
  )

const providerIdFor = (item: ToolCall): Option.Option<string> => geminiField(item, (g) => g.id)

// The originating call's Gemini id, looked up from history by our `call_id`.
// Gemini 3 maps a `functionResponse` back to its call by this id, so parallel
// calls to the same function are mis-paired if we drop it.
const providerIdForCallId = (
  history: ReadonlyArray<HistoryItem>,
  call_id: string,
): Option.Option<string> =>
  pipe(
    history,
    Arr.findFirst((item): item is ToolCall => isFunctionCallItem(item) && item.call_id === call_id),
    Option.flatMap(providerIdFor),
  )

const signatureFor = (item: ToolCall): Option.Option<string> =>
  geminiField(item, (g) => g.thoughtSignature)

const itemToContent =
  (history: ReadonlyArray<HistoryItem>) =>
  (item: HistoryItem): Result.Result<RequestContent, void> =>
    Match.value(item).pipe(
      Match.discriminatorsExhaustive("type")({
        message: messageToContent,
        function_call: (f) =>
          Result.succeed({
            role: "model" as const,
            parts: [
              {
                ...Option.match(signatureFor(f), {
                  onSome: (thoughtSignature) => ({ thoughtSignature }),
                  onNone: () => ({}),
                }),
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
                  ...Option.match(providerIdForCallId(history, o.call_id), {
                    onSome: (id) => ({ id }),
                    onNone: () => ({}),
                  }),
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

const toolDescriptorsToTools = (
  tools: ReadonlyArray<ToolDescriptor>,
): ReadonlyArray<RequestTool> =>
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

/**
 * Map our cross-provider `toolChoice` onto Gemini's `functionCallingConfig`.
 * Gemini honours the same three modes plus a function allow-list, so the
 * choice is mapped, not dropped. `undefined` keeps the API default (`AUTO`).
 */
const toolChoiceToFunctionCallingConfig = (
  toolChoice: CommonRequest["toolChoice"],
): RequestToolConfig["functionCallingConfig"] =>
  Match.value(toolChoice ?? "auto").pipe(
    Match.when("auto", () => ({ mode: "AUTO" as const })),
    Match.when("required", () => ({ mode: "ANY" as const })),
    Match.when("none", () => ({ mode: "NONE" as const })),
    Match.orElse((tc) => ({ mode: "ANY" as const, allowedFunctionNames: [tc.name] })),
  )

/**
 * URL-form images need Gemini's Files API (upload, then `fileData`); we
 * don't pre-upload, so such a part would otherwise vanish from the request.
 * The caller fails the request with `Unsupported` instead of silently
 * dropping the image.
 */
export const hasUrlImageSource = (history: ReadonlyArray<HistoryItem>): boolean =>
  history.some(
    (item) =>
      item.type === "message" &&
      item.content.some((b) => b.type === "input_image" && b.source._tag === "url"),
  )

export const buildRequestBody = (
  history: ReadonlyArray<HistoryItem>,
  generationConfig: Option.Option<GenerationConfig>,
  tools: ReadonlyArray<ToolDescriptor> = [],
  providerToolEntries: ReadonlyArray<RequestTool> = [],
  toolChoice: CommonRequest["toolChoice"] = undefined,
): RequestBody => {
  const systemTexts = pipe(allMessages(history), Arr.filterMap(systemMessageText))
  const contents = pipe(history, Arr.filterMap(itemToContent(history)))
  const functionTools = toolDescriptorsToTools(tools)
  const requestTools = [...functionTools, ...providerToolEntries]
  return {
    contents,
    ...(systemTexts.length > 0 && {
      systemInstruction: { parts: [{ text: systemTexts.join("\n") }] },
    }),
    ...Option.match(generationConfig, {
      onNone: () => ({}),
      onSome: (cfg) => ({ generationConfig: cfg }),
    }),
    ...(requestTools.length > 0 && { tools: requestTools }),
    // Only force a function-calling mode when there are function declarations;
    // a grounding-only request must keep the API default.
    ...(functionTools.length > 0 && {
      toolConfig: { functionCallingConfig: toolChoiceToFunctionCallingConfig(toolChoice) },
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
  /** Thought signature from Gemini 3, replayed on the next request's part. */
  readonly signature: Option.Option<string>
  /** Args as JSON-encoded string, mirroring `Items.ToolCall.arguments`. */
  readonly arguments: string
}

export type Accumulator = {
  readonly text: string
  readonly reasoning: string
  readonly functionCalls: ReadonlyArray<AccumulatedFunctionCall>
  /** Grounding citations, accumulated (de-duped by url) across chunks. */
  readonly annotations: ReadonlyArray<Annotation>
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
  annotations: [],
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
      readonly signature: Option.Option<string>
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
    signature: Option.fromNullishOr(p.thoughtSignature),
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
    Arr.filterMap((p) => (p.kind === kind ? Result.succeed(p.text) : Result.failVoid)),
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
  signature: call.signature,
  // `functionCallToChunkParts` already replaced null/undefined with `{}`,
  // so `call.args` is always a JSON-encodable value here.
  arguments: JSON.stringify(call.args),
})

const appendFunctionCalls = (
  prior: ReadonlyArray<AccumulatedFunctionCall>,
  fromChunk: ReadonlyArray<Extract<ChunkPart, { kind: "function_call" }>>,
): ReadonlyArray<AccumulatedFunctionCall> =>
  fromChunk.reduce<ReadonlyArray<AccumulatedFunctionCall>>(
    (acc, call) => [...acc, chunkCallToAccumulated(acc, call)],
    prior,
  )

// Grounding usually arrives on the final chunk, but merge across chunks and
// de-dupe by url so a mid-stream metadata block is not lost or double-counted.
const mergeAnnotations = (
  prev: ReadonlyArray<Annotation>,
  next: ReadonlyArray<Annotation>,
): ReadonlyArray<Annotation> =>
  next.length === 0 ? prev : Arr.dedupeWith(Arr.appendAll(prev, next), sameUrlCitation)

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
      annotations: mergeAnnotations(
        acc.annotations,
        groundingToAnnotations(chunk.candidates?.[0]?.groundingMetadata),
      ),
      finishReason: Option.orElse(finishReason, () => acc.finishReason),
      usage: mergeUsage(acc.usage, chunk.usageMetadata),
    },
  }
}

const reasoningItems = (acc: Accumulator): ReadonlyArray<HistoryItem> =>
  acc.reasoning.length > 0 ? [{ type: "reasoning", summary: acc.reasoning }] : []

const assistantMessageItems = (acc: Accumulator): ReadonlyArray<HistoryItem> =>
  acc.text.length === 0
    ? []
    : [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: acc.text,
              ...(acc.annotations.length > 0 && { annotations: acc.annotations }),
            },
          ],
        },
      ]

const functionCallItems = (acc: Accumulator): ReadonlyArray<HistoryItem> =>
  pipe(
    acc.functionCalls,
    Arr.map((c) => {
      const gemini = {
        ...(Option.isSome(c.providerId) && { id: c.providerId.value }),
        ...(Option.isSome(c.signature) && { thoughtSignature: c.signature.value }),
      }
      return {
        type: "function_call" as const,
        call_id: c.callId,
        name: c.name,
        arguments: c.arguments,
        ...(Object.keys(gemini).length > 0 && { providerData: { gemini } }),
      }
    }),
  )

export const accumulatorToTurn = (acc: Accumulator): Turn => ({
  stop_reason:
    acc.functionCalls.length > 0 ? ("tool_calls" as const) : finishReasonToStop(acc.finishReason),
  usage: { ...acc.usage },
  items: [...reasoningItems(acc), ...assistantMessageItems(acc), ...functionCallItems(acc)],
})
