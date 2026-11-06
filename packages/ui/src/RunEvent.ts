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

export const PROTOCOL_VERSION = 1

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
  messageId: Schema.String,
  /** Client input ids this run consumed, for optimistic-UI reconciliation. */
  inputs: Schema.Array(InputId),
  protocol: Schema.Literal(PROTOCOL_VERSION),
})

/** A pause point the client must answer (today: a tool call awaiting approval). */
export const Interrupt = Schema.Struct({
  callId: Schema.String,
  reason: Schema.Literal("approval"),
  name: Schema.String,
  input: Schema.Unknown,
})
export type Interrupt = typeof Interrupt.Type

export const RunCompleted = event("run-completed", { metadata: Schema.optional(Schema.Unknown) })
export const RunInterrupted = event("run-interrupted", { interrupts: Schema.Array(Interrupt) })
export const RunFailed = event("run-failed", {
  reason: Schema.String,
  retryable: Schema.Boolean,
  message: Schema.optional(Schema.String),
})
export const RunStopped = event("run-stopped", {
  by: Schema.optional(Schema.Literals(["user", "barge-in"])),
})

// ---------------------------------------------------------------------------
// Steps (one per model turn) and content
// ---------------------------------------------------------------------------

export const StepStarted = event("step-started", {})
export const StepFinished = event("step-finished", { usage: Schema.optional(Items.Usage) })
/** Discard the current step's partial output (mid-stream fallback or retry). */
export const StepReset = event("step-reset", {})

export const TextDelta = event("text-delta", { text: Schema.String })
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
export const ObjectDone = event("object-done", { id: Schema.String, value: Schema.Unknown })
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

/** Reference to tool-provided UI (MCP Apps). Reserved; unused in v1. */
const ToolUi = Schema.Struct({ server: Schema.String, resourceUri: Schema.String })

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
  input: Schema.Unknown,
  ui: Schema.optional(ToolUi),
})
/** The run is waiting in-process for a decision on this call (it keeps running). */
export const ToolApprovalRequested = event("tool-approval-requested", {
  callId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
})
export const ToolProgress = event("tool-progress", { callId: Schema.String, data: Schema.Unknown })
export const ToolResult = event("tool-result", {
  callId: Schema.String,
  output: Schema.Unknown,
  isError: Schema.Boolean,
  ui: Schema.optional(ToolUi),
})
export const ToolCancelled = event("tool-cancelled", { callIds: Schema.Array(Schema.String) })

// ---------------------------------------------------------------------------
// Usage and app payloads
// ---------------------------------------------------------------------------

export const Usage = event("usage", { usage: Items.Usage })
/** Persisted app payload; a repeated `id` replaces the earlier one in place. */
export const Data = event("data", {
  name: Schema.String,
  value: Schema.Unknown,
  id: Schema.optional(Schema.String),
})
/** Transient app payload (metrics, status); latest value wins, never stored in a message. */
export const Live = event("live", { name: Schema.String, value: Schema.Unknown })

// ---------------------------------------------------------------------------
// Unions and envelope
// ---------------------------------------------------------------------------

export const Terminal = Schema.Union([RunCompleted, RunInterrupted, RunFailed, RunStopped])
export type Terminal = typeof Terminal.Type

export const RunEvent = Schema.Union([
  RunStarted,
  RunCompleted,
  RunInterrupted,
  RunFailed,
  RunStopped,
  StepStarted,
  StepFinished,
  StepReset,
  TextDelta,
  ReasoningStarted,
  ReasoningDelta,
  Citation,
  Image,
  ObjectStarted,
  ObjectDelta,
  ObjectDone,
  ObjectFailed,
  ToolCallStarted,
  ToolCallArgsDelta,
  ToolCallReady,
  ToolApprovalRequested,
  ToolProgress,
  ToolResult,
  ToolCancelled,
  Usage,
  Data,
  Live,
])
export type RunEvent = typeof RunEvent.Type

export const Envelope = Schema.Struct({
  streamId: StreamId,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Set on run-scoped events; absent on stream-scoped ones. */
  runId: Schema.optional(RunId),
  event: RunEvent,
})
export type Envelope = typeof Envelope.Type

/** JSON codec for the wire: `Uint8Array` image bytes and other non-JSON values encode safely. */
export const EnvelopeJson = Schema.toCodecJson(Envelope)

const terminalTypes: ReadonlySet<RunEvent["type"]> = new Set([
  "run-completed",
  "run-interrupted",
  "run-failed",
  "run-stopped",
])

export const isTerminal = (event: RunEvent): event is Terminal => terminalTypes.has(event.type)
