/**
 * The client's view of one server run: plain data folded from envelopes.
 * `initial` + `step` plug into `Stream.scan` (live states) or
 * `Stream.runFold` (final state). `step` is pure, total and idempotent on
 * `seq`, so replaying a stream from any point is safe. A delta replaces only
 * the block it touches; every other block keeps its identity.
 *
 * `P` types the payloads (see `UiContract`): with a contract, a tool block
 * narrows by `name` to its decoded input and output. Without one (`Untyped`),
 * payloads are the JSON the server sent.
 */
import * as Items from "@effect-uai/core/Items"
import { Array as Arr, JsonPatch, Match, Option, Schema } from "effect"
import {
  type Envelope,
  InputId,
  Interrupt as InterruptSchema,
  type Interrupt,
  type Json,
  type NamedPayload,
  type Payloads,
  RunId,
  type RunEvent,
  type ToolPayload,
  type Untyped,
} from "./RunEvent.js"

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
])
export type ToolStatus = typeof ToolStatus.Type

export const ObjectStatus = Schema.Literals(["streaming", "done", "failed"])
export type ObjectStatus = typeof ObjectStatus.Type

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

export type TextBlock = typeof TextBlock.Type
export type RefusalBlock = typeof RefusalBlock.Type
export type ImageBlock = typeof ImageBlock.Type
export type ReasoningBlock = typeof ReasoningBlock.Type

/**
 * A tool call; `id` is the call id. A failed call (denied, cancelled, an error)
 * is `failed` with the server's `error`, e.g. `{ kind: "denied" }`: what a kind
 * means is the app's call.
 */
export type ToolBlock<P extends Payloads = Untyped> = P["tool"] extends infer T
  ? T extends ToolPayload
    ? {
        readonly type: "tool"
        readonly id: string
        readonly name: T["name"]
        readonly status: ToolStatus
        readonly input?: T["input"]
        readonly argsText?: string
        readonly output?: T["output"]
        readonly error?: Json
        readonly progress: ReadonlyArray<Json>
      }
    : never
  : never

type UnnamedObject = {
  readonly type: "object"
  readonly id: string
  readonly name?: undefined
  readonly status: ObjectStatus
  readonly partial?: Json
  readonly value?: Json
  readonly issues?: ReadonlyArray<Json>
}

/** A structured object: `partial` while it streams, the typed `value` once done. */
export type ObjectBlock<P extends Payloads = Untyped> =
  | UnnamedObject
  | (P["object"] extends infer T
      ? T extends NamedPayload
        ? {
            readonly type: "object"
            readonly id: string
            readonly name: T["name"]
            readonly status: ObjectStatus
            readonly partial?: Json
            readonly value?: T["value"]
            readonly issues?: ReadonlyArray<Json>
          }
        : never
      : never)

/** A persisted app payload; a repeated id replaces it in place. */
export type DataBlock<P extends Payloads = Untyped> = P["data"] extends infer T
  ? T extends NamedPayload
    ? {
        readonly type: "data"
        readonly id: string
        readonly name: T["name"]
        readonly value: T["value"]
      }
    : never
  : never

export type Block<P extends Payloads = Untyped> =
  | TextBlock
  | RefusalBlock
  | ImageBlock
  | ReasoningBlock
  | ToolBlock<P>
  | ObjectBlock<P>
  | DataBlock<P>

/** Transient payloads by name; the latest value wins. A contract's names are optional keys. */
export type Live<P extends Payloads = Untyped> = string extends P["live"]["name"]
  ? { readonly [name: string]: P["live"]["value"] }
  : { readonly [T in P["live"] as T["name"]]?: T["value"] }

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

const RunError = Schema.Struct({
  reason: Schema.String,
  message: Schema.optionalKey(Schema.String),
})

export type RunView<P extends Payloads = Untyped> = {
  readonly runId?: RunId
  readonly name?: string
  readonly inputs: ReadonlyArray<InputId>
  readonly status: Status
  readonly blocks: ReadonlyArray<Block<P>>
  readonly interrupts: ReadonlyArray<Interrupt<P>>
  readonly live: Live<P>
  readonly usage?: Items.Usage
  readonly metadata?: P["metadata"]
  readonly error?: typeof RunError.Type
  /** Highest applied `seq`; envelopes at or below it are ignored. */
  readonly lastSeq: number
  /** Index of the current step's first block (for `step-reset`). */
  readonly stepStart: number
  readonly nextBlock: number
}

// ---------------------------------------------------------------------------
// Schemas: built from payload codecs, so `UiContract` builds the typed ones
// ---------------------------------------------------------------------------

/** Block schemas for one tool, object or data name; `UiContract` makes one per name. */
export const toolBlock = <N extends Schema.Top, I extends Schema.Top, O extends Schema.Top>(
  name: N,
  input: I,
  output: O,
) =>
  Schema.Struct({
    type: Schema.Literal("tool"),
    id: Schema.String,
    name,
    status: ToolStatus,
    input: Schema.optionalKey(input),
    argsText: Schema.optionalKey(Schema.String),
    output: Schema.optionalKey(output),
    error: Schema.optionalKey(Schema.Json),
    progress: Schema.Array(Schema.Json),
  })

export const objectBlock = <N extends Schema.Top, V extends Schema.Top>(name: N, value: V) =>
  Schema.Struct({
    type: Schema.Literal("object"),
    id: Schema.String,
    name,
    status: ObjectStatus,
    partial: Schema.optionalKey(Schema.Json),
    value: Schema.optionalKey(value),
    issues: Schema.optionalKey(Schema.Array(Schema.Json)),
  })

export const dataBlock = <N extends Schema.Top, V extends Schema.Top>(name: N, value: V) =>
  Schema.Struct({ type: Schema.Literal("data"), id: Schema.String, name, value })

/** Blocks without payloads: the same in every view. */
export const contentBlocks = [TextBlock, RefusalBlock, ImageBlock, ReasoningBlock] as const

/** A view's schema from its payload-dependent parts; `block` is the whole block union. */
export const schema = <
  B extends Schema.Top,
  I extends Schema.Top,
  L extends Schema.Top,
  M extends Schema.Top,
>(parts: {
  readonly block: B
  readonly interrupt: I
  readonly live: L
  readonly metadata: M
}) =>
  Schema.Struct({
    runId: Schema.optionalKey(RunId),
    name: Schema.optionalKey(Schema.String),
    inputs: Schema.Array(InputId),
    status: Status,
    blocks: Schema.Array(parts.block),
    interrupts: Schema.Array(parts.interrupt),
    live: parts.live,
    usage: Schema.optionalKey(Items.Usage),
    metadata: Schema.optionalKey(parts.metadata),
    error: Schema.optionalKey(RunError),
    lastSeq: Schema.Number,
    stepStart: Schema.Number,
    nextBlock: Schema.Number,
  })

/** An object without a name: no contract entry, so its value stays JSON. */
export const unnamedObject = Schema.Struct({
  type: Schema.Literal("object"),
  id: Schema.String,
  status: ObjectStatus,
  partial: Schema.optionalKey(Schema.Json),
  value: Schema.optionalKey(Schema.Json),
  issues: Schema.optionalKey(Schema.Array(Schema.Json)),
})

const untypedObject = Schema.Union([objectBlock(Schema.String, Schema.Json), unnamedObject])

/** The untyped view's schema: payloads are JSON. */
export const RunView = schema({
  block: Schema.Union([
    ...contentBlocks,
    toolBlock(Schema.String, Schema.Json, Schema.Json),
    untypedObject,
    dataBlock(Schema.String, Schema.Json),
  ]),
  interrupt: InterruptSchema,
  live: Schema.Record(Schema.String, Schema.Json),
  metadata: Schema.Json,
})

/** An empty view (a contract's `initial` is the typed one). */
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
// Fold: written once over `Payloads` (names are strings, payloads `unknown`);
// the exported signatures carry the caller's `P`.
// ---------------------------------------------------------------------------

type View = RunView<Payloads>
type AnyBlock = Block<Payloads>
type AnyTool = ToolBlock<Payloads>
type AnyObject = ObjectBlock<Payloads>

const replaceAt = (blocks: ReadonlyArray<AnyBlock>, index: number, block: AnyBlock) =>
  blocks.map((b, i) => (i === index ? block : b))

const push = (v: View, make: (id: string) => AnyBlock): View => ({
  ...v,
  blocks: [...v.blocks, make(`b${v.nextBlock}`)],
  nextBlock: v.nextBlock + 1,
})

const appendText = (v: View, kind: "output_text" | "refusal" | "reasoning", text: string): View => {
  const index = v.blocks.length - 1
  const last = v.blocks[index]
  if (last !== undefined && last.type === kind && index >= v.stepStart) {
    return { ...v, blocks: replaceAt(v.blocks, index, { ...last, text: last.text + text }) }
  }
  return push(v, (id) => ({ type: kind, id, text }))
}

// A citation joins the step's latest text; one that arrives before any text
// starts an empty text block, which the following text extends.
const cite = (v: View, annotation: Items.Annotation): View =>
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

const updateTool = (
  v: View,
  callId: string,
  name: string,
  f: (block: AnyTool) => AnyTool,
): View => {
  const index = v.blocks.findIndex((b) => b.type === "tool" && b.id === callId)
  const current = v.blocks[index]
  if (current !== undefined && current.type === "tool") {
    return { ...v, blocks: replaceAt(v.blocks, index, f(current)) }
  }
  const created: AnyTool = {
    type: "tool",
    id: callId,
    name,
    status: "input-streaming",
    progress: [],
  }
  return { ...v, blocks: [...v.blocks, f(created)] }
}

const updateObject = (v: View, id: string, f: (block: AnyObject) => AnyObject): View => {
  const index = v.blocks.findIndex((b) => b.type === "object" && b.id === id)
  const current = v.blocks[index]
  if (current !== undefined && current.type === "object") {
    return { ...v, blocks: replaceAt(v.blocks, index, f(current)) }
  }
  return { ...v, blocks: [...v.blocks, f({ type: "object", id, status: "streaming" })] }
}

const applyPatch = Option.liftThrowable(JsonPatch.apply)
// An unnamed object has no contract entry, so its value stays JSON.
const isJson = Schema.is(Schema.Json)

// A bad patch leaves the partial value as is; the next snapshot or `object-done` repairs it.
const objectDelta = (
  block: AnyObject,
  e: Extract<RunEvent, { type: "object-delta" }>,
): AnyObject => {
  if (e.value !== undefined) return { ...block, partial: e.value }
  const patch = e.patch
  if (patch === undefined) return block
  return applyPatch(patch, block.partial ?? {}).pipe(
    Option.match({ onNone: () => block, onSome: (partial) => ({ ...block, partial }) }),
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

const withUsage = (v: View, usage: Items.Usage | undefined): View => {
  const total = addUsage(v.usage, usage)
  return total === undefined ? v : { ...v, usage: total }
}

const apply = (v: View, event: RunEvent<Payloads>): View =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      "run-started": (e): View => ({
        ...v,
        status: "streaming",
        runId: e.runId,
        inputs: e.inputs,
        ...(e.name !== undefined ? { name: e.name } : {}),
      }),
      "run-completed": (e): View => ({
        ...v,
        status: "completed",
        ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
      }),
      "run-interrupted": (e): View =>
        e.interrupts.reduce<View>(
          (acc, i) =>
            updateTool(acc, i.callId, i.name, (b) => ({
              ...b,
              status: "awaiting-approval",
              input: i.input,
            })),
          { ...v, status: "interrupted", interrupts: e.interrupts },
        ),
      "run-failed": (e): View => ({
        ...v,
        status: "failed",
        error: {
          reason: e.reason,
          ...(e.message !== undefined ? { message: e.message } : {}),
        },
      }),
      "run-stopped": (): View => ({ ...v, status: "stopped" }),
      "step-started": (): View => ({ ...v, stepStart: v.blocks.length }),
      "step-finished": (e): View => withUsage(v, e.usage),
      "step-reset": (): View => ({ ...v, blocks: v.blocks.slice(0, v.stepStart) }),
      "text-delta": (e) => appendText(v, "output_text", e.text),
      "refusal-delta": (e) => appendText(v, "refusal", e.text),
      "reasoning-started": (): View =>
        v.blocks.some((b, i) => b.type === "reasoning" && i >= v.stepStart)
          ? v
          : push(v, (id) => ({ type: "reasoning", id, text: "" })),
      "reasoning-delta": (e) => appendText(v, "reasoning", e.text),
      citation: (e) => cite(v, e.annotation),
      image: (e): View => {
        const index = v.blocks.length - 1
        const last = v.blocks[index]
        const block = (id: string): AnyBlock =>
          e.partialIndex === undefined
            ? { type: "output_image", id, source: e.image }
            : { type: "output_image", id, source: e.image, partialIndex: e.partialIndex }
        // A preview frame is replaced by the next preview or the final image.
        return last !== undefined && last.type === "output_image" && last.partialIndex !== undefined
          ? { ...v, blocks: replaceAt(v.blocks, index, block(last.id)) }
          : push(v, block)
      },
      "object-started": (e): View =>
        updateObject(v, e.id, (b) => (e.name === undefined ? b : { ...b, name: e.name })),
      "object-delta": (e) => updateObject(v, e.id, (b) => objectDelta(b, e)),
      "object-done": (e) =>
        updateObject(v, e.id, (b) =>
          b.name === undefined
            ? { ...b, status: "done", ...(isJson(e.value) ? { value: e.value } : {}) }
            : { ...b, status: "done", value: e.value },
        ),
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
        updateTool(v, e.callId, e.name, (b) =>
          e.isError
            ? { ...b, status: "failed", error: e.output }
            : { ...b, status: "done", output: e.output },
        ),
      usage: (e): View => ({ ...v, usage: e.usage }),
      data: (e): View => {
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
      live: (e): View => ({ ...v, live: { ...v.live, [e.name]: e.value } }),
      // Stream-scoped; a chat fold (`Thread`) shows it, a run view has nothing to add.
      "input-accepted": (): View => v,
    }),
  )

/**
 * Fold one envelope into the view. Ignores envelopes already applied
 * (`seq <= lastSeq`) and run-scoped envelopes of a different run.
 */
export function step<P extends Payloads = Untyped>(
  view: RunView<P>,
  envelope: Envelope<P>,
): RunView<P>
export function step(view: View, envelope: Envelope<Payloads>): View {
  if (envelope.seq <= view.lastSeq) return view
  const otherRun =
    view.runId !== undefined && envelope.runId !== undefined && envelope.runId !== view.runId
  return { ...(otherRun ? view : apply(view, envelope.event)), lastSeq: envelope.seq }
}

/** A tool event that can answer a call made in an earlier run (after an approval). */
export type ToolUpdate<P extends Payloads = Untyped> = Extract<
  RunEvent<P>,
  { readonly type: "tool-result" | "tool-progress" }
>

export const isToolUpdate = <P extends Payloads>(event: RunEvent<P>): event is ToolUpdate<P> =>
  event.type === "tool-result" || event.type === "tool-progress"

/**
 * Apply a tool event to the view if it holds that call; `None` if it doesn't.
 * For a run that already ended (an interrupted run whose call was approved
 * later), so `seq` and the run id are not checked.
 */
export function applyToolUpdate<P extends Payloads>(
  view: RunView<P>,
  event: ToolUpdate<P>,
): Option.Option<RunView<P>>
export function applyToolUpdate(view: View, event: ToolUpdate<Payloads>): Option.Option<View> {
  const holds = view.blocks.some((b) => b.type === "tool" && b.id === event.callId)
  return holds ? Option.some(apply(view, event)) : Option.none()
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<Status> = new Set(["completed", "interrupted", "failed", "stopped"])

export const isTerminal = <P extends Payloads>(view: RunView<P>): boolean =>
  TERMINAL.has(view.status)

export const isBusy = <P extends Payloads>(view: RunView<P>): boolean =>
  view.status === "submitted" || view.status === "streaming"

/** All assistant text of the run, in order (refusals excluded, see `refusal`). */
export function text<P extends Payloads>(view: RunView<P>): string
export function text(view: View): string {
  return view.blocks.flatMap((b) => (b.type === "output_text" ? [b.text] : [])).join("")
}

/** The refusal text, if the model declined; `undefined` otherwise. */
export function refusal<P extends Payloads>(view: RunView<P>): string | undefined
export function refusal(view: View): string | undefined {
  const parts = view.blocks.flatMap((b) => (b.type === "refusal" ? [b.text] : []))
  return parts.length === 0 ? undefined : parts.join("")
}
