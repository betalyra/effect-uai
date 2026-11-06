/**
 * Optional chat model on top of `RunView`: a message list plus the run that
 * is still streaming. Apps with a different model fold `RunView` themselves
 * and skip this module.
 */
import * as Items from "@effect-uai/core/Items"
import { serializeValue } from "@effect-uai/core/ToolResult"
import { Schema } from "effect"
import * as Input from "./Input.js"
import { type Envelope, InputId, StreamId } from "./RunEvent.js"
import * as RunView from "./RunView.js"

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  /** The client input id. */
  id: InputId,
  messages: Schema.Array(Input.UserMessage),
})
export type UserMessage = typeof UserMessage.Type

/** A settled run. */
export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  id: Schema.String,
  run: RunView.RunView,
})
export type AssistantMessage = typeof AssistantMessage.Type

export const Message = Schema.Union([UserMessage, AssistantMessage])
export type Message = typeof Message.Type

export const Thread = Schema.Struct({
  messages: Schema.Array(Message),
  /** The run still streaming, if any. */
  active: Schema.NullOr(RunView.RunView),
  /**
   * Inputs sent while a run was active, waiting for their own run (a server
   * that queues). They join `messages` when a `run-started` lists them.
   */
  pending: Schema.Array(UserMessage),
  /** The stream `lastSeq` counts in; a frame from another stream starts a new count. */
  streamId: Schema.NullOr(StreamId),
  /** Highest applied `seq` across runs, so a settled run's frames stay deduplicated. */
  lastSeq: Schema.Number,
})
export type Thread = typeof Thread.Type

export const initial: Thread = {
  messages: [],
  active: null,
  pending: [],
  streamId: null,
  lastSeq: 0,
}

/** Whether the thread already shows the input `id` (settled or pending). */
export const hasInput = (thread: Thread, id: InputId): boolean =>
  thread.messages.some((m) => m.role === "user" && m.id === id) ||
  thread.pending.some((m) => m.id === id)

// `seq` is per stream: a run on a new stream (one stream per run) counts from 1 again.
const onStream = (thread: Thread, envelope: Envelope): Thread =>
  envelope.streamId === thread.streamId
    ? thread
    : {
        ...thread,
        streamId: envelope.streamId,
        lastSeq: 0,
        active: thread.active === null ? null : { ...thread.active, lastSeq: 0 },
      }

/**
 * Optimistic: show the user's message before the server answers. When idle,
 * it starts a submitted run; while a run is active, it waits in `pending`.
 */
export const submitted = (thread: Thread, input: Input.Submit): Thread => {
  const message: UserMessage = { role: "user", id: input.id, messages: input.messages }
  return thread.active === null
    ? {
        ...thread,
        messages: [...thread.messages, message],
        active: { ...RunView.initial, status: "submitted", lastSeq: thread.lastSeq },
      }
    : { ...thread, pending: [...thread.pending, message] }
}

// A starting run takes its inputs out of `pending`, so they sit above its answer.
const consume = (thread: Thread, envelope: Envelope): Thread => {
  const event = envelope.event
  if (event.type !== "run-started" || thread.pending.length === 0) return thread
  const taken = (m: UserMessage) => event.inputs.includes(m.id)
  return {
    ...thread,
    messages: [...thread.messages, ...thread.pending.filter(taken)],
    pending: thread.pending.filter((m) => !taken(m)),
  }
}

/** Fold one envelope; a run that reaches its terminal settles into `messages`. */
export const step = (current: Thread, envelope: Envelope): Thread => {
  const fresh = onStream(current, envelope)
  if (envelope.seq <= fresh.lastSeq) return current
  const thread = consume(fresh, envelope)
  // Stream-scoped frames (no `runId`) and frames outside a run are not a run's content.
  if (
    envelope.runId === undefined ||
    (thread.active === null && envelope.event.type !== "run-started")
  ) {
    return { ...thread, lastSeq: envelope.seq }
  }
  const run = RunView.step(
    thread.active ?? { ...RunView.initial, lastSeq: thread.lastSeq },
    envelope,
  )
  if (!RunView.isTerminal(run)) return { ...thread, active: run, lastSeq: envelope.seq }
  const settled: AssistantMessage = {
    role: "assistant",
    id: run.messageId ?? run.runId ?? `seq-${envelope.seq}`,
    run,
  }
  return { ...thread, messages: [...thread.messages, settled], active: null, lastSeq: envelope.seq }
}

/**
 * Settle the active run when its stream ends without a terminal: `"stopped"`
 * when the client cancelled it, `"disconnected"` when the connection failed.
 */
export const ended = (thread: Thread, reason: "stopped" | "disconnected"): Thread => {
  const run = thread.active
  if (run === null) return thread
  const final: RunView.RunView =
    reason === "stopped"
      ? { ...run, status: "stopped" }
      : { ...run, status: "failed", error: { reason: "disconnected", retryable: true } }
  const settled: AssistantMessage = {
    role: "assistant",
    id: run.messageId ?? run.runId ?? `seq-${thread.lastSeq}`,
    run: final,
  }
  return { ...thread, messages: [...thread.messages, settled], active: null }
}

/** Drop everything after `messageId` (regenerate, edit). */
export const truncateAfter = (thread: Thread, messageId: string): Thread => {
  const index = thread.messages.findIndex((m) => m.id === messageId)
  return index === -1
    ? thread
    : { ...thread, messages: thread.messages.slice(0, index + 1), active: null }
}

const assistantItems = (run: RunView.RunView): ReadonlyArray<Items.HistoryItem> => {
  const text = RunView.text(run)
  const tools = run.blocks.flatMap((b): ReadonlyArray<Items.HistoryItem> =>
    b.type === "tool" && b.status === "done"
      ? [
          {
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: serializeValue(b.input ?? {}),
          },
          Items.toolCallOutput(b.id, serializeValue(b.output)),
        ]
      : [],
  )
  return [...tools, ...(text.length > 0 ? [Items.assistantText(text)] : [])]
}

/**
 * Messages as model history, for client-owned history. Lossy by design:
 * `providerData` (encrypted reasoning, item ids) never reaches the client,
 * so reasoning-model apps should keep history on the server.
 */
export const toHistory = (messages: ReadonlyArray<Message>): ReadonlyArray<Items.HistoryItem> =>
  messages.flatMap((m) => (m.role === "user" ? Input.toHistory(m) : assistantItems(m.run)))
