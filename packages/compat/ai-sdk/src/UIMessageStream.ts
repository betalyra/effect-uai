/**
 * Project an effect-uai loop onto the Vercel AI SDK "UI Message Stream"
 * protocol (the `v1` wire format, stable across AI SDK v5–v7). The output is a
 * `Stream<SSE.Event>` ready for `SSE.toBytes`; a `useChat` client on the other
 * end consumes it with no frontend changes.
 *
 * The encoder input is an `Emission`: every `InteractionEvent` the loop
 * produces, plus optional `dataPart` and `messageMetadata` emissions a caller
 * interleaves to stream custom typed data (e.g. live metrics) and settled
 * per-message metadata (e.g. usage). A plain `Stream<InteractionEvent>` is a
 * valid `Stream<Emission>`, so existing callers are unaffected.
 *
 * The protocol wants a stable id and explicit start/end lifecycle around each
 * text and reasoning block, which effect-uai's delta events don't carry. This
 * module synthesizes them: one block id per turn, opened on the first delta
 * and closed on `TurnComplete`.
 */
import type * as SSE from "@effect-uai/core/SSE"
import * as Turn from "@effect-uai/core/Turn"
import { Match, Option, Stream } from "effect"

/**
 * The stream parts `useChat` consumes. Names and shapes are the wire
 * contract with the AI SDK client; keep them literal.
 */
export type Part =
  | { readonly type: "start"; readonly messageId: string }
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "reasoning-start"; readonly id: string }
  | { readonly type: "reasoning-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "reasoning-end"; readonly id: string }
  | { readonly type: "tool-input-start"; readonly toolCallId: string; readonly toolName: string }
  | {
      readonly type: "tool-input-delta"
      readonly toolCallId: string
      readonly inputTextDelta: string
    }
  | {
      readonly type: "tool-input-available"
      readonly toolCallId: string
      readonly toolName: string
      readonly input: unknown
    }
  | {
      readonly type: "tool-output-available"
      readonly toolCallId: string
      readonly output: unknown
    }
  | {
      readonly type: `data-${string}`
      readonly id?: string
      readonly data: unknown
      readonly transient?: boolean
    }
  | { readonly type: "message-metadata"; readonly messageMetadata: unknown }
  | { readonly type: "error"; readonly errorText: string }
  | { readonly type: "finish" }

/**
 * A custom typed data part (`data-<name>`). `transient: true` delivers it to
 * the client's `onData` callback only (not persisted into `message.parts`);
 * reuse an `id` across emissions to reconcile/update one part in place.
 */
export type DataEmission = {
  readonly kind: "data"
  readonly name: string
  readonly data: unknown
  readonly id?: string
  readonly transient?: boolean
}

/** Settled per-message metadata, surfaced as `message.metadata` on the client. */
export type MetadataEmission = {
  readonly kind: "metadata"
  readonly metadata: unknown
}

/**
 * What `toUIMessageStream` encodes: loop `InteractionEvent`s plus optional
 * data / metadata emissions a caller interleaves into the stream.
 */
export type Emission = Turn.InteractionEvent | DataEmission | MetadataEmission

/** Construct a `data-<name>` emission. See {@link DataEmission}. */
export const dataPart = (
  name: string,
  data: unknown,
  options?: { readonly id?: string; readonly transient?: boolean },
): DataEmission => ({ kind: "data", name, data, ...options })

/** Construct a message-metadata emission. See {@link MetadataEmission}. */
export const messageMetadata = (metadata: unknown): MetadataEmission => ({
  kind: "metadata",
  metadata,
})

/**
 * Headers the UI Message Stream protocol requires on the HTTP response.
 * `x-vercel-ai-ui-message-stream: v1` is mandatory; without it the client
 * falls back to the plain text-stream protocol and ignores non-text parts.
 * Pure data, so it composes with any server (web `Response`, `@effect/platform`
 * `HttpServerResponse`, raw Node) - the package deliberately owns no HTTP layer.
 */
export const responseHeaders: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
}

const parseJson = Option.liftThrowable(JSON.parse)

// Tool arguments/output cross effect-uai as JSON strings; hand the client the
// decoded value, falling back to the raw string when it isn't JSON.
const decode = (raw: string): unknown => Option.getOrElse(parseJson(raw), () => raw)

const event = (part: Part | "[DONE]"): SSE.Event => ({
  data: part === "[DONE]" ? "[DONE]" : JSON.stringify(part),
})

type State = {
  readonly messageId: string
  readonly textId: string | null
  readonly reasoningId: string | null
  readonly seq: number
}

type Step = readonly [State, ReadonlyArray<Part>]

const toDataPart = (d: DataEmission): Part => {
  const base: Part = { type: `data-${d.name}`, data: d.data }
  const withId = d.id !== undefined ? { ...base, id: d.id } : base
  return d.transient !== undefined ? { ...withId, transient: d.transient } : withId
}

// One emission fans out to zero or more parts (a first TextDelta opens a block
// *and* emits its delta), so each step yields an array.
const step = (s: State, ev: Emission): Step =>
  Match.value(ev).pipe(
    Match.tags({
      TextDelta: (e): Step => {
        if (s.textId !== null) return [s, [{ type: "text-delta", id: s.textId, delta: e.text }]]
        const id = `${s.messageId}:t${s.seq}`
        return [
          { ...s, textId: id, seq: s.seq + 1 },
          [
            { type: "text-start", id },
            { type: "text-delta", id, delta: e.text },
          ],
        ]
      },
      ReasoningDelta: (e): Step => {
        if (s.reasoningId !== null)
          return [s, [{ type: "reasoning-delta", id: s.reasoningId, delta: e.text }]]
        const id = `${s.messageId}:r${s.seq}`
        return [
          { ...s, reasoningId: id, seq: s.seq + 1 },
          [
            { type: "reasoning-start", id },
            { type: "reasoning-delta", id, delta: e.text },
          ],
        ]
      },
      ToolCallStart: (e): Step => [
        s,
        [{ type: "tool-input-start", toolCallId: e.call_id, toolName: e.name }],
      ],
      ToolCallArgsDelta: (e): Step => [
        s,
        [{ type: "tool-input-delta", toolCallId: e.call_id, inputTextDelta: e.delta }],
      ],
      RefusalDelta: (e): Step => [s, [{ type: "error", errorText: e.text }]],
      UsageUpdate: (): Step => [s, []],
      // Grounding progress and streamed citations have no UI Message Stream
      // part; the citations still arrive on `TurnComplete.turn`.
      WebSearchCall: (): Step => [s, []],
      CitationAdded: (): Step => [s, []],
      TurnComplete: (e): Step => {
        const closing: ReadonlyArray<Part> = [
          ...(s.textId !== null ? [{ type: "text-end", id: s.textId } as const] : []),
          ...(s.reasoningId !== null
            ? [{ type: "reasoning-end", id: s.reasoningId } as const]
            : []),
          ...Turn.getToolCalls(e.turn).map((call): Part => ({
            type: "tool-input-available",
            toolCallId: call.call_id,
            toolName: call.name,
            input: decode(call.arguments),
          })),
        ]
        // Reset block ids; the loop may run further turns after tools resolve.
        return [{ ...s, textId: null, reasoningId: null }, closing]
      },
    }),
    // The non-`_tag` arm of InteractionEvent: a resolved tool result the loop
    // appended after running the tool.
    Match.when({ type: "function_call_output" }, (o): Step => [
      s,
      [{ type: "tool-output-available", toolCallId: o.call_id, output: decode(o.output) }],
    ]),
    // Caller-interleaved emissions.
    Match.when({ kind: "data" }, (d): Step => [s, [toDataPart(d)]]),
    Match.when({ kind: "metadata" }, (m): Step => [
      s,
      [{ type: "message-metadata", messageMetadata: m.metadata }],
    ]),
    Match.exhaustive,
  )

/**
 * Encode an `InteractionEvent` stream as UI Message Stream `SSE.Event`s,
 * bracketed by the protocol's `start` and terminal `finish` / `[DONE]`
 * markers. `messageId` identifies the assistant message on the client.
 */
export const toUIMessageStream =
  (messageId: string) =>
  <E, R>(self: Stream.Stream<Emission, E, R>): Stream.Stream<SSE.Event, E, R> =>
    Stream.make(event({ type: "start", messageId })).pipe(
      Stream.concat(
        Stream.mapAccum(
          self,
          (): State => ({ messageId, textId: null, reasoningId: null, seq: 0 }),
          (s, ev: Emission): readonly [State, ReadonlyArray<SSE.Event>] => {
            const [next, parts] = step(s, ev)
            return [next, parts.map(event)]
          },
        ),
      ),
      Stream.concat(Stream.make(event({ type: "finish" }), event("[DONE]"))),
    )
