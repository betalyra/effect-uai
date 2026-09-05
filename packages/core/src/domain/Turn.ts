import { Data, Effect, Result, Schema, Stream, pipe } from "effect"
import * as StructuredFormat from "../structured-format/StructuredFormat.js"
import type { ImageSource } from "./Image.js"
import {
  type Annotation,
  HistoryItem,
  Message,
  Reasoning,
  StopReason,
  ToolCall,
  ToolCallOutput,
  Usage,
  isOutputImage,
  isOutputText,
  isReasoning,
  isRefusal,
  isToolCall,
} from "./Items.js"

/**
 * The result of a single LLM generation. A turn produces zero or more items
 * (typically one assistant message and zero or more function_call items)
 * and reports usage + a stop reason.
 */
export const Turn = Schema.Struct({
  items: Schema.Array(HistoryItem),
  usage: Usage,
  stop_reason: StopReason,
})
export type Turn = typeof Turn.Type

/**
 * Canonical events emitted while a single turn is being generated. Most
 * variants are streaming deltas (text, reasoning, tool-call args); the
 * terminal `TurnComplete` carries the assembled `Turn`. Lifecycle members
 * aren't deltas, hence the union name.
 *
 * `ReasoningDelta.kind`: `trace` is the model's raw chain-of-thought;
 * `summary` is a model-written summary intended for display. OpenAI
 * Responses emits both; Anthropic and Gemini only emit `trace`.
 *
 * `RefusalDelta`: the model declined to answer. OpenAI Responses emits
 * this as its own event; Anthropic surfaces refusals via `stop_reason`
 * and Gemini collapses them into `finishReason: SAFETY` — both go
 * without a `RefusalDelta`.
 *
 * `UsageUpdate`: mid-stream cumulative usage. Anthropic emits this on
 * `message_start` and `message_delta`; other providers may only deliver
 * usage via `TurnComplete.turn.usage`.
 *
 * `WebSearchCall`: lifecycle of a provider-executed web search within the
 * turn. Fires only when the turn grounds against search; absent otherwise.
 *
 * `ImageOutput`: an image the model produced, whether it drew it as part
 * of its turn or reached a hosted tool for it. `partialIndex` marks a
 * preview frame from providers that stream them; the finished image
 * arrives without one and is also on `TurnComplete.turn` as an
 * `OutputImage` block.
 *
 * `CitationAdded`: a citation attached to the answer, emitted incrementally
 * where the provider streams citations. Providers that bundle citations emit
 * none of these; their citations still arrive on `TurnComplete.turn`
 * (`OutputText.annotations`). Either way the final set is on the assembled turn.
 */
export type TurnEvent = Data.TaggedEnum<{
  TextDelta: { readonly text: string }
  ReasoningDelta: { readonly text: string; readonly kind: "trace" | "summary" }
  RefusalDelta: { readonly text: string }
  ToolCallStart: { readonly call_id: string; readonly name: string }
  ToolCallArgsDelta: { readonly call_id: string; readonly delta: string }
  UsageUpdate: { readonly usage: Usage }
  WebSearchCall: {
    readonly status: "started" | "searching" | "completed"
    readonly query?: string
    readonly action?: "search" | "open_page" | "find_in_page"
  }
  ImageOutput: {
    readonly image: ImageSource
    /** Set only on a preview frame, counting from 0. Absent means finished. */
    readonly partialIndex?: number
  }
  CitationAdded: { readonly annotation: Annotation }
  TurnComplete: { readonly turn: Turn }
}>

export const TurnEvent = Data.taggedEnum<TurnEvent>()

/**
 * What flows out of an agent loop body to its consumer per turn: every
 * `TurnEvent` the provider emits (including the terminal `TurnComplete`
 * carrying the assembled `Turn`), plus the output of any tool the loop ran.
 * Both variants carry a `_tag` discriminator.
 */
export type InteractionEvent = TurnEvent | ToolCallOutput

export const isTurnComplete = TurnEvent.$is("TurnComplete")

export const getToolCalls = (turn: Turn): ReadonlyArray<ToolCall> => turn.items.filter(isToolCall)

export const reasonings = (turn: Turn): ReadonlyArray<Reasoning> => turn.items.filter(isReasoning)

export const assistantMessages = (turn: Turn): ReadonlyArray<Message> =>
  turn.items.filter((i): i is Message => i.type === "message" && i.role === "assistant")

/**
 * Every `output_text` payload across every assistant message in the turn,
 * preserving order. Refusals and other content blocks are dropped — use
 * `assistantMessages` if you need to inspect them. The primitive for
 * "give me the assistant's text"; callers decide how to combine
 * (typically `.join("")` for prose or `.join(" ")` for log strings).
 */
export const assistantTexts = (turn: Turn): ReadonlyArray<string> =>
  assistantMessages(turn)
    .flatMap((m) => m.content)
    .filter(isOutputText)
    .map((b) => b.text)

/**
 * Sugar over `assistantTexts(turn).join("")` — the common case for
 * summarizers, classifiers, judge calls, and structured-output backstops
 * that want one concatenated string.
 */
export const assistantText = (turn: Turn): string => assistantTexts(turn).join("")

/**
 * Every image the model produced this turn, in order. The counterpart to
 * {@link assistantTexts}: each is an `ImageSource`, so it can be written
 * to disk or passed straight back as an `input_image` on the next turn.
 */
export const assistantImages = (turn: Turn): ReadonlyArray<ImageSource> =>
  assistantMessages(turn)
    .flatMap((m) => m.content)
    .filter(isOutputImage)
    .map((b) => b.source)

/**
 * Rewrite assistant `output_image` blocks into a user message carrying
 * the same pictures as `input_image`, so another provider can look at
 * what this one drew.
 *
 * Only Gemini's wire has an assistant-role image part; every other
 * adapter omits an `output_image` on replay and says so. Moving it to a
 * user message is the conversion that makes it portable, and it is
 * yours to make rather than the adapter's: "the assistant drew this" and
 * "here is an image, look at it" are different claims, and silently
 * swapping one for the other behind your back would be the wrong kind of
 * helpful.
 *
 * Items with no images pass through untouched, and the new user message
 * follows the assistant message it came from.
 */
export const imagesAsInput = (history: ReadonlyArray<HistoryItem>): ReadonlyArray<HistoryItem> =>
  history.flatMap((item) => {
    if (item.type !== "message" || item.role !== "assistant") return [item]
    const images = item.content.filter(isOutputImage)
    return images.length === 0
      ? [item]
      : [
          item,
          {
            type: "message" as const,
            role: "user" as const,
            content: images.map((b) => ({ type: "input_image" as const, source: b.source })),
          },
        ]
  })

/**
 * Every citation annotation attached to the turn's assistant `output_text`
 * blocks, in order. The flat view of a grounded turn's sources, whether the
 * turn came from a normal generation with native search or a deep-research job.
 */
export const citations = (turn: Turn): ReadonlyArray<Annotation> =>
  assistantMessages(turn)
    .flatMap((m) => m.content)
    .filter(isOutputText)
    .flatMap((b) => b.annotations ?? [])

/**
 * Append a completed turn and optional follow-up items to a state record's
 * history. Recipes use this at the point where structured tool results are
 * converted to model-facing `ToolCallOutput`s.
 */
export const appendToHistory = <S extends { readonly history: ReadonlyArray<HistoryItem> }>(
  state: S,
  turn: Turn,
  items: ReadonlyArray<HistoryItem> = [],
): S => ({
  ...state,
  history: [...state.history, ...turn.items, ...items],
})

// ---------------------------------------------------------------------------
// Stream operators
// ---------------------------------------------------------------------------

/**
 * Project a `TurnEvent` stream onto its `TextDelta` payloads. Other
 * variants are dropped. Composes with `Lines.lines` +
 * `decodeJsonLines` for prompted-JSONL streaming.
 */
export const textDeltas = <E, R>(
  self: Stream.Stream<TurnEvent, E, R>,
): Stream.Stream<string, E, R> =>
  self.pipe(
    Stream.filterMap((ev) => (ev._tag === "TextDelta" ? Result.succeed(ev.text) : Result.failVoid)),
  )

// ---------------------------------------------------------------------------
// Structured-output integration
// ---------------------------------------------------------------------------

/**
 * The assistant message on the just-completed turn was a refusal block,
 * not an `output_text` payload. Returned by `decodeStructured` to short-circuit
 * decoding before `JSON.parse` / schema validation runs.
 */
export class RefusalRejected extends Data.TaggedError("RefusalRejected")<{
  readonly turn: Turn
}> {}

const lastAssistantContent = (turn: Turn): { readonly text: string; readonly refused: boolean } => {
  const assistants = assistantMessages(turn)
  const last = assistants[assistants.length - 1]
  if (last === undefined) return { text: "", refused: false }
  if (last.content.some(isRefusal)) return { text: "", refused: true }
  const text = last.content
    .filter(isOutputText)
    .map((b) => b.text)
    .join("")
  return { text, refused: false }
}

/**
 * Validate a completed `Turn` against a `StructuredFormat`. Concatenates
 * `output_text` blocks on the last assistant message, then runs
 * `JSON.parse` + the format's schema validation.
 *
 * Three failure modes:
 * - `RefusalRejected` — the assistant emitted a refusal block.
 * - `JsonParseError` — the assembled text wasn't valid JSON.
 * - `StructuredDecodeError` — the JSON didn't match the schema.
 */
export const decodeStructured = <A>(
  turn: Turn,
  format: StructuredFormat.StructuredFormat<A>,
): Effect.Effect<
  A,
  RefusalRejected | StructuredFormat.JsonParseError | StructuredFormat.StructuredDecodeError
> =>
  pipe(lastAssistantContent(turn), ({ text, refused }) =>
    refused ? Effect.fail(new RefusalRejected({ turn })) : StructuredFormat.parseJson(format)(text),
  )
