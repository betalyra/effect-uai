/**
 * The `@effect-uai/ui` wire protocol (v1): what a server streams to a client
 * about agent runs. Every frame is an `Envelope`; `seq` is per stream,
 * starts at 1 and never repeats, so clients dedupe and resume by it.
 *
 * A run starts with `run-started` and ends with exactly one terminal
 * (`run-completed`, `run-interrupted`, `run-failed`, `run-stopped`). Field
 * names are camelCase; the event discriminator is `type`.
 */
import * as Img from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import { Schema } from "effect"

export const PROTOCOL_VERSION = 2

// ---------------------------------------------------------------------------
// Ids: branded so a stream, run and input id can't be swapped. Wire decoding
// brands them; build one by hand with `StreamId.make("st_1")`.
// ---------------------------------------------------------------------------

export const StreamId = Schema.String.pipe(Schema.brand("StreamId"))
export type StreamId = typeof StreamId.Type

export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

/** Client-generated id of one input. */
export const InputId = Schema.String.pipe(Schema.brand("InputId"))
export type InputId = typeof InputId.Type

const event = <const T extends string, const F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), ...fields })

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export const RunStarted = event("run-started", {
  runId: RunId,
  /** Role of the run when a stream carries several, e.g. "assistant", "reviewer". */
  name: Schema.optional(Schema.String),
  /** Client input ids this run consumed, for optimistic-UI reconciliation. */
  inputs: Schema.Array(InputId),
  protocol: Schema.Literal(PROTOCOL_VERSION),
})

/** A pause point the client must answer (today: a tool call awaiting approval). */
export const Interrupt = Schema.Struct({
  callId: Schema.String,
  reason: Schema.Literal("approval"),
  name: Schema.String,
  input: Schema.Json,
})

export const RunCompleted = event("run-completed", { metadata: Schema.optional(Schema.Json) })
export const RunInterrupted = event("run-interrupted", { interrupts: Schema.Array(Interrupt) })
/** `reason` is a short code (an error's `_tag`); whether to offer a retry is the client's call. */
export const RunFailed = event("run-failed", {
  reason: Schema.String,
  message: Schema.optional(Schema.String),
})
export const RunStopped = event("run-stopped", {})

// ---------------------------------------------------------------------------
// Steps (one per model turn) and content
// ---------------------------------------------------------------------------

export const StepStarted = event("step-started", {})
export const StepFinished = event("step-finished", { usage: Schema.optional(Items.Usage) })
/** Discard the current step's partial output (mid-stream fallback or retry). */
export const StepReset = event("step-reset", {})

export const TextDelta = event("text-delta", { text: Schema.String })
/** The model declined to answer; distinct from text (core's `refusal` block). */
export const RefusalDelta = event("refusal-delta", { text: Schema.String })
export const ReasoningStarted = event("reasoning-started", {})
export const ReasoningDelta = event("reasoning-delta", {
  text: Schema.String,
  kind: Schema.Literals(["trace", "summary"]),
})
export const Citation = event("citation", { annotation: Items.Annotation })
export const Image = event("image", {
  image: Img.ImageSource,
  /** Set only on a preview frame; absent means final. */
  partialIndex: Schema.optional(Schema.Number),
})

// ---------------------------------------------------------------------------
// Structured objects
// ---------------------------------------------------------------------------

const JsonPatchOperation = Schema.Union([
  Schema.Struct({ op: Schema.Literal("add"), path: Schema.String, value: Schema.Json }),
  Schema.Struct({ op: Schema.Literal("remove"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("replace"), path: Schema.String, value: Schema.Json }),
])

export const ObjectStarted = event("object-started", {
  id: Schema.String,
  /** Which schema or list the object belongs to. */
  name: Schema.optional(Schema.String),
})
/** Either a JSON Patch against the previous partial value, or a snapshot `value`. */
export const ObjectDelta = event("object-delta", {
  id: Schema.String,
  patch: Schema.optional(Schema.Array(JsonPatchOperation)),
  value: Schema.optional(Schema.Json),
})
export const ObjectDone = event("object-done", {
  id: Schema.String,
  /** The object's name again, so a client can decode `value` without state. */
  name: Schema.optional(Schema.String),
  value: Schema.Json,
})
export const ObjectFailed = event("object-failed", {
  id: Schema.String,
  issues: Schema.Array(
    Schema.Struct({
      path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
      message: Schema.String,
    }),
  ),
})

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const ToolCallStarted = event("tool-call-started", {
  callId: Schema.String,
  name: Schema.String,
})
export const ToolCallArgsDelta = event("tool-call-args-delta", {
  callId: Schema.String,
  delta: Schema.String,
})
export const ToolCallReady = event("tool-call-ready", {
  callId: Schema.String,
  name: Schema.String,
  input: Schema.Json,
})
/** The run is waiting in-process for a decision on this call (it keeps running). */
export const ToolApprovalRequested = event("tool-approval-requested", {
  callId: Schema.String,
  name: Schema.String,
  input: Schema.Json,
})
/** An intermediate value of a streaming tool, encoded like its output. */
export const ToolPartial = event("tool-partial", {
  callId: Schema.String,
  name: Schema.String,
  value: Schema.Json,
})

/** How a call ended: its output, or an error (the tool's, core's, or the app's). */
export const outcome = <V extends Schema.Top, E extends Schema.Top>(value: V, error: E) =>
  Schema.Union([
    Schema.TaggedStruct("Success", { value }),
    Schema.TaggedStruct("Failure", { error }),
  ])

/** An outcome as sent: value and error are JSON. */
export const Outcome = outcome(Schema.Json, Schema.Json)

export type Outcome<V = Json, E = Json> =
  | { readonly _tag: "Success"; readonly value: V }
  | { readonly _tag: "Failure"; readonly error: E }

/**
 * Every call ends with one `tool-result`: calls that ran, and calls the app
 * closed itself (denied, cancelled, answered by the user).
 */
export const ToolResult = event("tool-result", {
  callId: Schema.String,
  /** The tool's name, so a client can decode `result` without state. */
  name: Schema.String,
  result: Outcome,
})

// ---------------------------------------------------------------------------
// Usage and app payloads
// ---------------------------------------------------------------------------

export const Usage = event("usage", { usage: Items.Usage })
/** Persisted app payload; a repeated `id` replaces the earlier one in place. */
export const Data = event("data", {
  name: Schema.String,
  value: Schema.Json,
  id: Schema.optional(Schema.String),
})
/** Transient app payload (metrics, status); latest value wins, never stored in a message. */
export const Live = event("live", { name: Schema.String, value: Schema.Json })

/**
 * Stream-scoped: the server accepted an input (queued or about to run). Lets a
 * reloaded client show inputs that wait for their run. `input` is the app's
 * encoded input (e.g. `Input.InputJson`); its run's `run-started` lists its id.
 */
export const InputAccepted = event("input-accepted", { input: Schema.Json })

// ---------------------------------------------------------------------------
// Unions and envelope
// ---------------------------------------------------------------------------

/** Events whose payloads a contract types (see `UiContract`). */
export const payloadEvents = [
  RunCompleted,
  RunInterrupted,
  ObjectDone,
  ToolCallReady,
  ToolApprovalRequested,
  ToolPartial,
  ToolResult,
  Data,
  Live,
] as const

/** Events a contract leaves as they are. */
export const plainEvents = [
  RunStarted,
  RunFailed,
  RunStopped,
  StepStarted,
  StepFinished,
  StepReset,
  TextDelta,
  RefusalDelta,
  ReasoningStarted,
  ReasoningDelta,
  Citation,
  Image,
  ObjectStarted,
  ObjectDelta,
  ObjectFailed,
  ToolCallStarted,
  ToolCallArgsDelta,
  Usage,
  InputAccepted,
] as const

/** The protocol as sent: payloads are JSON. A contract decodes them (`UiContract`). */
export const RunEvent = Schema.Union([...plainEvents, ...payloadEvents])

export const envelopeFields = {
  streamId: StreamId,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Set on run-scoped events; absent on stream-scoped ones. */
  runId: Schema.optional(RunId),
}

export const Envelope = Schema.Struct({ ...envelopeFields, event: RunEvent })

/** JSON codec for the wire: `Uint8Array` image bytes and other non-JSON values encode safely. */
export const EnvelopeJson = Schema.toCodecJson(Envelope)

// ---------------------------------------------------------------------------
// Payload types: what a contract types. `P` defaults to `Untyped` (JSON as sent).
// ---------------------------------------------------------------------------

export type Json = Schema.Json

export type ToolPayload = {
  readonly name: string
  readonly input: unknown
  readonly output: unknown
  /** Every error a call of this tool can end with. */
  readonly failure: unknown
}
export type NamedPayload = { readonly name: string; readonly value: unknown }

/** Typed payloads: each field is a union with one member per name. */
export type Payloads = {
  readonly tool: ToolPayload
  readonly object: NamedPayload
  readonly data: NamedPayload
  readonly live: NamedPayload
  readonly metadata: unknown
}

/** No contract: any name, payloads as sent. */
export type Untyped = {
  readonly tool: {
    readonly name: string
    readonly input: Json
    readonly output: Json
    readonly failure: Json
  }
  readonly object: { readonly name: string; readonly value: Json }
  readonly data: { readonly name: string; readonly value: Json }
  readonly live: { readonly name: string; readonly value: Json }
  readonly metadata: Json
}

type Plain = (typeof plainEvents)[number]["Type"]

// Distributes over the tool union, so narrowing by `name` types `value` and `result`.
type ToolEvents<T> = T extends ToolPayload
  ?
      | {
          readonly type: "tool-partial"
          readonly callId: string
          readonly name: T["name"]
          readonly value: T["output"]
        }
      | {
          readonly type: "tool-result"
          readonly callId: string
          readonly name: T["name"]
          readonly result: Outcome<T["output"], T["failure"]>
        }
  : never

export type Interrupt<P extends Payloads = Untyped> = {
  readonly callId: string
  readonly reason: "approval"
  readonly name: P["tool"]["name"]
  readonly input: P["tool"]["input"]
}

type Typed<P extends Payloads> =
  | { readonly type: "run-completed"; readonly metadata?: P["metadata"] | undefined }
  | { readonly type: "run-interrupted"; readonly interrupts: ReadonlyArray<Interrupt<P>> }
  | {
      readonly type: "object-done"
      readonly id: string
      readonly name?: P["object"]["name"] | undefined
      readonly value: P["object"]["value"]
    }
  | {
      readonly type: "tool-call-ready"
      readonly callId: string
      readonly name: P["tool"]["name"]
      readonly input: P["tool"]["input"]
    }
  | {
      readonly type: "tool-approval-requested"
      readonly callId: string
      readonly name: P["tool"]["name"]
      readonly input: P["tool"]["input"]
    }
  | ToolEvents<P["tool"]>
  | {
      readonly type: "data"
      readonly name: P["data"]["name"]
      readonly value: P["data"]["value"]
      readonly id?: string | undefined
    }
  | { readonly type: "live"; readonly name: P["live"]["name"]; readonly value: P["live"]["value"] }

/** One event; with a contract's `P`, its payloads are decoded. */
export type RunEvent<P extends Payloads = Untyped> = Plain | Typed<P>

export type Envelope<P extends Payloads = Untyped> = {
  readonly streamId: StreamId
  readonly seq: number
  readonly runId?: RunId | undefined
  readonly event: RunEvent<P>
}

export type Terminal<P extends Payloads = Untyped> = Extract<
  RunEvent<P>,
  { readonly type: "run-completed" | "run-interrupted" | "run-failed" | "run-stopped" }
>

const terminalTypes: ReadonlySet<string> = new Set([
  "run-completed",
  "run-interrupted",
  "run-failed",
  "run-stopped",
])

export const isTerminal = <P extends Payloads = Untyped>(
  event: RunEvent<P>,
): event is Terminal<P> => terminalTypes.has(event.type)
