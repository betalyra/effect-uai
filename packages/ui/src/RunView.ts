/**
 * The client's view of one server run: plain data folded from envelopes.
 * `initial` + `step` plug into `Stream.scan` (live states) or
 * `Stream.runFold` (final state). `step` is pure, total and idempotent on
 * `seq`, so replaying a stream from any point is safe. A delta replaces only
 * the block it touches; every other block keeps its identity.
 */
import * as Items from "@effect-uai/core/Items"
import { Array as Arr, JsonPatch, Match, Option, Predicate, Schema } from "effect"
import { type Envelope, InputId, Interrupt, RunId, type RunEvent } from "./RunEvent.js"

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const ToolStatus = Schema.Literals([
  "input-streaming",
  "ready",
  "awaiting-approval",
  "running",
  "done",
  "failed",
  "denied",
  "cancelled",
])
export type ToolStatus = typeof ToolStatus.Type

// Settled content reuses core's shapes (plus a block `id`), so a view's text,
// citations, images and refusals read like the turn's own content blocks.

/** Core's `output_text`; citations attach to the text they cite. */
const TextBlock = Schema.Struct({ ...Items.OutputText.fields, id: Schema.String })
/** Core's `refusal`: the model declined to answer. */
const RefusalBlock = Schema.Struct({ ...Items.Refusal.fields, id: Schema.String })
/** Core's `output_image`; `partialIndex` marks a preview the final image replaces. */
const ImageBlock = Schema.Struct({
  ...Items.OutputImage.fields,
  id: Schema.String,
  partialIndex: Schema.optionalKey(Schema.Number),
})
const ReasoningBlock = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  text: Schema.String,
})
/** `id` is the tool call id. */
const ToolBlock = Schema.Struct({
  type: Schema.Literal("tool"),
  id: Schema.String,
  name: Schema.String,
  status: ToolStatus,
  input: Schema.optionalKey(Schema.Unknown),
  argsText: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.Unknown),
  progress: Schema.Array(Schema.Unknown),
})
const ObjectBlock = Schema.Struct({
  type: Schema.Literal("object"),
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["streaming", "done", "failed"]),
  value: Schema.optionalKey(Schema.Unknown),
  issues: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})
const DataBlock = Schema.Struct({
  type: Schema.Literal("data"),
  id: Schema.String,
  name: Schema.String,
  value: Schema.Unknown,
})

export const Block = Schema.Union([
  TextBlock,
  RefusalBlock,
  ImageBlock,
  ReasoningBlock,
  ToolBlock,
  ObjectBlock,
  DataBlock,
])
export type Block = typeof Block.Type
export type TextBlock = typeof TextBlock.Type
export type ToolBlock = typeof ToolBlock.Type
export type ObjectBlock = typeof ObjectBlock.Type

export const Status = Schema.Literals([
  "idle",
  "submitted",
  "streaming",
  "completed",
  "interrupted",
  "failed",
  "stopped",
])
export type Status = typeof Status.Type

export const RunView = Schema.Struct({
  runId: Schema.optionalKey(RunId),
  name: Schema.optionalKey(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
  inputs: Schema.Array(InputId),
  status: Status,
  blocks: Schema.Array(Block),
  interrupts: Schema.Array(Interrupt),
  /** Transient payloads by name; latest value wins. */
  live: Schema.Record(Schema.String, Schema.Unknown),
  usage: Schema.optionalKey(Items.Usage),
  metadata: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      reason: Schema.String,
      retryable: Schema.Boolean,
      message: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Highest applied `seq`; envelopes at or below it are ignored. */
  lastSeq: Schema.Number,
  /** Index of the current step's first block (for `step-reset`). */
  stepStart: Schema.Number,
  nextBlock: Schema.Number,
})
export type RunView = typeof RunView.Type

export const initial: RunView = {
  inputs: [],
  status: "idle",
  blocks: [],
  interrupts: [],
  live: {},
  lastSeq: 0,
  stepStart: 0,
  nextBlock: 0,
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

const replaceAt = (blocks: ReadonlyArray<Block>, index: number, block: Block) =>
  blocks.map((b, i) => (i === index ? block : b))

const appendText = (
  v: RunView,
  kind: "output_text" | "refusal" | "reasoning",
  text: string,
): RunView => {
  const index = v.blocks.length - 1
  const last = v.blocks[index]
  if (last !== undefined && last.type === kind && index >= v.stepStart) {
    return { ...v, blocks: replaceAt(v.blocks, index, { ...last, text: last.text + text }) }
  }
  return push(v, (id) => ({ type: kind, id, text }))
}

// A citation joins the step's latest text; one that arrives before any text
// starts an empty text block, which the following text extends.
const cite = (v: RunView, annotation: Items.Annotation): RunView =>
  Arr.findLastIndex(v.blocks, (b, i) => b.type === "output_text" && i >= v.stepStart).pipe(
    Option.flatMap((index) =>
      Option.fromNullishOr(v.blocks[index]).pipe(
        Option.filter((b): b is TextBlock => b.type === "output_text"),
        Option.map((b) => ({ index, block: b })),
      ),
    ),
    Option.match({
      onNone: () =>
        push(v, (id) => ({ type: "output_text", id, text: "", annotations: [annotation] })),
      onSome: ({ index, block }) => ({
        ...v,
        blocks: replaceAt(v.blocks, index, {
          ...block,
          annotations: [...(block.annotations ?? []), annotation],
        }),
      }),
    }),
  )

const push = (v: RunView, make: (id: string) => Block): RunView => ({
  ...v,
  blocks: [...v.blocks, make(`b${v.nextBlock}`)],
  nextBlock: v.nextBlock + 1,
})

const updateTool = (
  v: RunView,
  callId: string,
  name: string,
  f: (block: ToolBlock) => ToolBlock,
): RunView => {
  const index = v.blocks.findIndex((b) => b.type === "tool" && b.id === callId)
  const current = v.blocks[index]
  if (current !== undefined && current.type === "tool") {
    return { ...v, blocks: replaceAt(v.blocks, index, f(current)) }
  }
  const created: ToolBlock = {
    type: "tool",
    id: callId,
    name,
    status: "input-streaming",
    progress: [],
  }
  return { ...v, blocks: [...v.blocks, f(created)] }
}

const updateObject = (v: RunView, id: string, f: (block: ObjectBlock) => ObjectBlock): RunView => {
  const index = v.blocks.findIndex((b) => b.type === "object" && b.id === id)
  const current = v.blocks[index]
  if (current !== undefined && current.type === "object") {
    return { ...v, blocks: replaceAt(v.blocks, index, f(current)) }
  }
  return { ...v, blocks: [...v.blocks, f({ type: "object", id, status: "streaming" })] }
}

const applyPatch = Option.liftThrowable(JsonPatch.apply)
const asJson = Schema.decodeUnknownOption(Schema.Json)

// A bad patch leaves the value as is; the next snapshot or `object-done` repairs it.
const objectDelta = (
  block: ObjectBlock,
  e: Extract<RunEvent, { type: "object-delta" }>,
): ObjectBlock => {
  if (e.value !== undefined) return { ...block, value: e.value }
  const patch = e.patch
  if (patch === undefined) return block
  return asJson(block.value ?? {}).pipe(
    Option.flatMap((base) => applyPatch(patch, base)),
    Option.match({ onNone: () => block, onSome: (value) => ({ ...block, value }) }),
  )
}

const sum = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)

const addUsage = (
  total: Items.Usage | undefined,
  step: Items.Usage | undefined,
): Items.Usage | undefined => {
  if (step === undefined) return total
  if (total === undefined) return step
  const input = sum(total.input_tokens, step.input_tokens)
  const output = sum(total.output_tokens, step.output_tokens)
  const all = sum(total.total_tokens, step.total_tokens)
  return {
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
    ...(all !== undefined ? { total_tokens: all } : {}),
  }
}

const withUsage = (v: RunView, usage: Items.Usage | undefined): RunView => {
  const total = addUsage(v.usage, usage)
  return total === undefined ? v : { ...v, usage: total }
}

const toolStatusOf = (output: unknown, isError: boolean): ToolStatus => {
  if (!isError) return "done"
  return Predicate.hasProperty(output, "kind") && output.kind === "denied" ? "denied" : "failed"
}

const apply = (v: RunView, event: RunEvent): RunView =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      "run-started": (e): RunView => ({
        ...v,
        status: "streaming",
        runId: e.runId,
        messageId: e.messageId,
        inputs: e.inputs,
        ...(e.name !== undefined ? { name: e.name } : {}),
      }),
      "run-completed": (e): RunView => ({
        ...v,
        status: "completed",
        ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
      }),
      "run-interrupted": (e): RunView =>
        e.interrupts.reduce<RunView>(
          (acc, i) =>
            updateTool(acc, i.callId, i.name, (b) => ({
              ...b,
              status: "awaiting-approval",
              input: i.input,
            })),
          { ...v, status: "interrupted", interrupts: e.interrupts },
        ),
      "run-failed": (e): RunView => ({
        ...v,
        status: "failed",
        error: {
          reason: e.reason,
          retryable: e.retryable,
          ...(e.message !== undefined ? { message: e.message } : {}),
        },
      }),
      "run-stopped": (): RunView => ({ ...v, status: "stopped" }),
      "step-started": (): RunView => ({ ...v, stepStart: v.blocks.length }),
      "step-finished": (e): RunView => withUsage(v, e.usage),
      "step-reset": (): RunView => ({ ...v, blocks: v.blocks.slice(0, v.stepStart) }),
      "text-delta": (e) => appendText(v, "output_text", e.text),
      "refusal-delta": (e) => appendText(v, "refusal", e.text),
      "reasoning-started": (): RunView =>
        v.blocks.some((b, i) => b.type === "reasoning" && i >= v.stepStart)
          ? v
          : push(v, (id) => ({ type: "reasoning", id, text: "" })),
      "reasoning-delta": (e) => appendText(v, "reasoning", e.text),
      citation: (e) => cite(v, e.annotation),
      image: (e): RunView => {
        const index = v.blocks.length - 1
        const last = v.blocks[index]
        const block = (id: string): Block =>
          e.partialIndex === undefined
            ? { type: "output_image", id, source: e.image }
            : { type: "output_image", id, source: e.image, partialIndex: e.partialIndex }
        // A preview frame is replaced by the next preview or the final image.
        return last !== undefined && last.type === "output_image" && last.partialIndex !== undefined
          ? { ...v, blocks: replaceAt(v.blocks, index, block(last.id)) }
          : push(v, block)
      },
      "object-started": (e): RunView =>
        updateObject(v, e.id, (b) => (e.name === undefined ? b : { ...b, name: e.name })),
      "object-delta": (e) => updateObject(v, e.id, (b) => objectDelta(b, e)),
      "object-done": (e) =>
        updateObject(v, e.id, (b) => ({ ...b, status: "done", value: e.value })),
      "object-failed": (e) =>
        updateObject(v, e.id, (b) => ({ ...b, status: "failed", issues: e.issues })),
      "tool-call-started": (e) => updateTool(v, e.callId, e.name, (b) => b),
      "tool-call-args-delta": (e) =>
        updateTool(v, e.callId, "", (b) => ({ ...b, argsText: (b.argsText ?? "") + e.delta })),
      "tool-call-ready": (e) =>
        updateTool(v, e.callId, e.name, (b) => ({
          ...b,
          name: e.name,
          status: "ready",
          input: e.input,
        })),
      "tool-approval-requested": (e) =>
        updateTool(v, e.callId, e.name, (b) => ({
          ...b,
          status: "awaiting-approval",
          input: e.input,
        })),
      "tool-progress": (e) =>
        updateTool(v, e.callId, "", (b) => ({
          ...b,
          status: "running",
          progress: [...b.progress, e.data],
        })),
      "tool-result": (e) =>
        updateTool(v, e.callId, "", (b) => ({
          ...b,
          status: toolStatusOf(e.output, e.isError),
          output: e.output,
        })),
      "tool-cancelled": (e) =>
        e.callIds.reduce(
          (acc, callId) =>
            updateTool(acc, callId, "", (b) => ({ ...b, status: "cancelled" as const })),
          v,
        ),
      usage: (e): RunView => ({ ...v, usage: e.usage }),
      data: (e): RunView => {
        const index =
          e.id === undefined ? -1 : v.blocks.findIndex((b) => b.type === "data" && b.id === e.id)
        const existing = v.blocks[index]
        return existing !== undefined
          ? {
              ...v,
              blocks: replaceAt(v.blocks, index, {
                type: "data",
                id: existing.id,
                name: e.name,
                value: e.value,
              }),
            }
          : push(v, (id) => ({ type: "data", id: e.id ?? id, name: e.name, value: e.value }))
      },
      live: (e): RunView => ({ ...v, live: { ...v.live, [e.name]: e.value } }),
      // Stream-scoped; a chat fold (`Thread`) shows it, a run view has nothing to add.
      "input-accepted": (): RunView => v,
    }),
  )

/**
 * Fold one envelope into the view. Ignores envelopes already applied
 * (`seq <= lastSeq`) and run-scoped envelopes of a different run.
 */
export const step = (view: RunView, envelope: Envelope): RunView => {
  if (envelope.seq <= view.lastSeq) return view
  const otherRun =
    view.runId !== undefined && envelope.runId !== undefined && envelope.runId !== view.runId
  return { ...(otherRun ? view : apply(view, envelope.event)), lastSeq: envelope.seq }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<Status> = new Set(["completed", "interrupted", "failed", "stopped"])

export const isTerminal = (view: RunView): boolean => TERMINAL.has(view.status)

export const isBusy = (view: RunView): boolean =>
  view.status === "submitted" || view.status === "streaming"

/** All assistant text of the run, in order (refusals excluded, see `refusal`). */
export const text = (view: RunView): string =>
  view.blocks.flatMap((b) => (b.type === "output_text" ? [b.text] : [])).join("")

/** The refusal text, if the model declined; `undefined` otherwise. */
export const refusal = (view: RunView): string | undefined => {
  const parts = view.blocks.flatMap((b) => (b.type === "refusal" ? [b.text] : []))
  return parts.length === 0 ? undefined : parts.join("")
}

/**
 * Object blocks named `name`, typed by `schema`. `value` is set once the
 * object is done and decodes; failed or unparseable objects carry `undefined`.
 */
export const objects = <A>(
  view: RunView,
  name: string,
  schema: Schema.Codec<A, any, never, never>,
): ReadonlyArray<{
  readonly id: string
  readonly status: ObjectBlock["status"]
  readonly value: A | undefined
}> => {
  const decode = Schema.decodeUnknownOption(schema)
  return view.blocks.flatMap((b) =>
    b.type === "object" && b.name === name
      ? [
          {
            id: b.id,
            status: b.status,
            value: b.status === "done" ? Option.getOrUndefined(decode(b.value)) : undefined,
          },
        ]
      : [],
  )
}
