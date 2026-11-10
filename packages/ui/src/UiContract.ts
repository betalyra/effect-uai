/**
 * A typed contract between server and client, built from Schemas only, so
 * both sides import the same value (the pattern of Effect's `HttpApi`). The
 * wire stays JSON; the client decodes each envelope once on arrival, and from
 * then on the state holds decoded values: a tool block narrowed by `name`
 * has its tool's input and output types, a `Date` is a `Date`.
 *
 *   const ChatUi = UiContract.make({ tools: [GetWeather], live: { metrics: Metrics } })
 *
 *   // server: typed payload events (tool outputs are encoded by the Toolkit)
 *   yield* ChatUi.live("metrics", { tokps: 42 })
 *
 *   // client: the state is typed by the contract
 *   const chat = Atoms.thread({ contract: ChatUi, transport, busy: "block" })
 *
 * The types list the contract's names only, so narrowing by name is exact. A
 * name the contract doesn't list (a newer server rolling out a tool) still
 * arrives, as JSON, but the types don't mention it: a `switch (b.name)` skips
 * it. A listed name whose payload doesn't decode fails the envelope: that is
 * a contract violation, not data to show.
 *
 * A tool is a core `Tool` or a shared spec (`as const`, schemas only). Its
 * result is `Success { value } | Failure { error }`: the error is the tool's
 * `failureSchema` (app closings like `ToolDecision.Denied` included) or core's
 * `ToolOutput.CoreError`.
 * Without `outputSchema`, values are a `Content.Value` (media as classes).
 */
import * as Content from "@effect-uai/core/Content"
import type * as Items from "@effect-uai/core/Items"
import type * as Tool from "@effect-uai/core/Tool"
import type { ToolInputSchema } from "@effect-uai/core/Tool"
import type * as ToolEvent from "@effect-uai/core/ToolEvent"
import * as ToolOutput from "@effect-uai/core/ToolOutput"
import { Effect, HashMap, Match, Option, Result, Schema } from "effect"
import * as Event from "./RunEvent.js"
import type { Envelope, Json, Payloads as AnyPayloads, RunEvent, ToolPayload } from "./RunEvent.js"
import * as RunView from "./RunView.js"
import * as Thread from "./Thread.js"

type AnyCodec = Schema.Codec<any, any, never, never>
// Tool values reach history and the UI through the same schema, so it must encode to JSON.
type JsonCodec = Schema.Codec<any, Schema.Json, never, never>

/** A tool as the contract sees it: a core `Tool` or a shared spec (`as const`). */
export type ToolSpec = {
  readonly name: string
  readonly inputSchema: AnyCodec | ToolInputSchema<any>
  readonly outputSchema?: JsonCodec
  readonly failureSchema?: JsonCodec
}

export type Spec = {
  readonly tools?: ReadonlyArray<ToolSpec>
  readonly objects?: Readonly<Record<string, AnyCodec>>
  readonly data?: Readonly<Record<string, AnyCodec>>
  readonly live?: Readonly<Record<string, AnyCodec>>
  readonly metadata?: AnyCodec
}

type InputOf<S> = S extends Schema.Top ? S["Type"] : S extends ToolInputSchema<infer A> ? A : Json
// A core `Tool` carries its types; a spec has them in its schemas. Without
// `outputSchema` a tool returns a `Content.Value`, and that is what arrives.
type CoreTool = { readonly _tag: "LocalTool" | "DeclaredTool" }
type OutputOf<T> = T extends CoreTool
  ? Tool.ToolOutput<T>
  : T extends { readonly outputSchema: infer O extends Schema.Top }
    ? O["Type"]
    : Content.Value
type FailureOf<T> = T extends CoreTool
  ? Tool.ToolFailure<T>
  : T extends { readonly failureSchema: infer F extends Schema.Top }
    ? F["Type"]
    : never
type ToolOf<T> = T extends ToolSpec
  ? {
      readonly name: T["name"]
      readonly input: InputOf<T["inputSchema"]>
      readonly output: OutputOf<T>
      readonly failure: FailureOf<T> | ToolOutput.CoreError
    }
  : never
type ElementOf<T> = T extends ReadonlyArray<infer E> ? E : never
type NamedOf<M> = {
  readonly [K in keyof M & string]: {
    readonly name: K
    readonly value: M[K] extends Schema.Top ? M[K]["Type"] : never
  }
}[keyof M & string]
/** The payload types a spec describes: its listed names only. */
export type PayloadsOf<S extends Spec> = {
  readonly tool: ToolOf<ElementOf<S["tools"]>>
  readonly object: NamedOf<S["objects"]>
  readonly data: NamedOf<S["data"]>
  readonly live: NamedOf<S["live"]>
  readonly metadata: S["metadata"] extends Schema.Top ? S["metadata"]["Type"] : Json
}

type NameOf<T> = T extends { readonly name: infer N } ? N : never
type ValueOf<T, N> =
  Extract<T, { readonly name: N }> extends { readonly value: infer V } ? V : never
type ToolField<T, N, K extends "output" | "failure"> =
  Extract<T, { readonly name: N }> extends infer X extends ToolPayload ? X[K] : never

/** The call an app closes itself: its id and the tool's name. */
export type Call<N extends string = string> = { readonly call_id: string; readonly name: N }

/**
 * A contract's payload types, for the generic folds:
 * `Thread.presetFor<UiContract.Payloads<typeof ChatUi>>()`.
 */
export type Payloads<C> = C extends UiContract<infer P> ? P : never

export interface UiContract<P extends AnyPayloads> {
  /** Decode a wire envelope (as `Client` reads it) into a typed one. */
  decode(envelope: Envelope): Effect.Effect<Envelope<P>, Schema.SchemaError>
  /** Typed envelope ⇄ wire envelope. */
  readonly Envelope: Schema.Codec<Envelope<P>, Envelope>
  /** A typed run view ⇄ the untyped one, for persisting or a framework's model. */
  readonly RunView: Schema.Codec<RunView.RunView<P>, RunView.RunView>
  /** A typed `Thread` ⇄ the untyped one. */
  readonly Thread: Schema.Codec<Thread.Thread<P>, Thread.Thread>
  /** Server: a `data` event with its value encoded for the wire. */
  data<N extends NameOf<P["data"]>>(
    name: N,
    value: ValueOf<P["data"], N>,
    options?: { readonly id?: string },
  ): Effect.Effect<RunEvent, Schema.SchemaError>
  /** Server: a `live` event with its value encoded for the wire. */
  live<N extends NameOf<P["live"]>>(
    name: N,
    value: ValueOf<P["live"], N>,
  ): Effect.Effect<RunEvent, Schema.SchemaError>
  /** Server: run metadata encoded for `run-completed`. */
  metadata(value: P["metadata"]): Effect.Effect<Json, Schema.SchemaError>
  /** Server: a toolkit event (`Toolkit.run`) encoded with the tool's schemas. */
  toolEvent(event: ToolEvent.ToolEvent): Effect.Effect<RunEvent, Schema.SchemaError>
  /** Server: a history item (already encoded) as the `tool-result` of tool `name`. */
  toolOutput(item: Items.ToolCallOutput, name: string): Effect.Effect<RunEvent, Schema.SchemaError>
  /** Server: close a call with a value of its tool's output (e.g. supplied by the user). */
  success<N extends NameOf<P["tool"]>>(
    call: Call<N>,
    value: ToolField<P["tool"], N, "output">,
  ): Effect.Effect<RunEvent, Schema.SchemaError>
  /** Server: close a call with an error (e.g. the app's `Denied`). */
  failure<N extends NameOf<P["tool"]>>(
    call: Call<N>,
    error: ToolField<P["tool"], N, "failure">,
  ): Effect.Effect<RunEvent, Schema.SchemaError>
}

// ---------------------------------------------------------------------------
// Runtime: one schema member per listed name, plus a fallback for the rest
// ---------------------------------------------------------------------------

const json = <S extends Schema.Top>(schema: S) => Schema.toCodecJson(schema)
const listed = (name: string) => Schema.Literal(name)
const unlisted = (names: ReadonlyArray<string>) =>
  Schema.String.check(Schema.makeFilter((name: string) => !names.includes(name)))

/** A payload codec: decodes from JSON without services. */
type PayloadCodec = Schema.Codec<unknown, unknown, never, never>

// A core `Tool` built from an Effect Schema keeps it (`fromEffectSchema`), so it decodes too.
const isCodec = (schema: ToolSpec["inputSchema"]): schema is AnyCodec => Schema.isSchema(schema)

// Effect Schemas decode the model's JSON; other Standard Schemas validate it as is.
const inputCodec = (tool: ToolSpec): PayloadCodec => {
  const schema = tool.inputSchema
  if (isCodec(schema)) return json(schema)
  return Schema.declare((u: unknown): u is Json => {
    const result = schema["~standard"].validate(u)
    return !(result instanceof Promise) && result.issues === undefined
  })
}
// "Anything": a tool typed `Content.Value`, or a name the contract doesn't list.
const isAnything = (tool: ToolSpec | undefined): boolean =>
  tool?.outputSchema === undefined || tool.outputSchema === Content.Value

// The tool's own schemas, as `Toolkit.output` uses them: they encode to JSON, so
// the UI and history agree by construction (no `toCodecJson` on top). "Anything"
// travels as typed parts, so JSON can't be mistaken for media.
const outputCodec = (tool: ToolSpec | undefined): PayloadCodec =>
  isAnything(tool) ? ToolOutput.ValueParts : (tool?.outputSchema ?? ToolOutput.ValueParts)

const encodeParts = Schema.encodeEffect(Schema.Array(ToolOutput.PartJson))

const failureCodec = (tool: ToolSpec | undefined): PayloadCodec =>
  tool?.failureSchema === undefined
    ? ToolOutput.CoreError
    : Schema.Union([tool.failureSchema, ToolOutput.CoreError])

const entries = (record: Readonly<Record<string, AnyCodec>> | undefined) =>
  Object.entries(record ?? {})

/** Encoded loosely; `make`'s signature carries the types. */
type Loose = {
  decode(envelope: Envelope): Effect.Effect<unknown, Schema.SchemaError>
  readonly Envelope: Schema.Top
  readonly RunView: Schema.Top
  readonly Thread: Schema.Top
  data(
    name: string,
    value: unknown,
    options?: { readonly id?: string },
  ): Effect.Effect<RunEvent, Schema.SchemaError>
  live(name: string, value: unknown): Effect.Effect<RunEvent, Schema.SchemaError>
  metadata(value: unknown): Effect.Effect<Json, Schema.SchemaError>
  toolEvent(event: ToolEvent.ToolEvent): Effect.Effect<RunEvent, Schema.SchemaError>
  toolOutput(item: Items.ToolCallOutput, name: string): Effect.Effect<RunEvent, Schema.SchemaError>
  success(call: Call, value: unknown): Effect.Effect<RunEvent, Schema.SchemaError>
  failure(call: Call, error: unknown): Effect.Effect<RunEvent, Schema.SchemaError>
}

const toJson = Schema.decodeUnknownEffect(Schema.Json)
const toOutcome = Schema.decodeUnknownEffect(Event.Outcome)

/**
 * Build a contract. Tool names must be literal types: pass core `Tool`s or
 * specs declared `as const`.
 */
export function make<const S extends Spec>(spec: S): UiContract<PayloadsOf<S>>
export function make(spec: Spec): Loose {
  const tools = spec.tools ?? []
  const objects = entries(spec.objects)
  const data = entries(spec.data)
  const live = entries(spec.live)
  const toolNames = tools.map((t) => t.name)
  const metadata = spec.metadata === undefined ? Schema.Json : json(spec.metadata)
  const resultCodec = (tool: ToolSpec | undefined) =>
    Event.outcome(outputCodec(tool), failureCodec(tool))
  // Built once per tool; an unlisted name falls back to the tool-less codecs.
  const codecsOf = (tool: ToolSpec | undefined) => ({
    output: outputCodec(tool),
    result: resultCodec(tool),
    anything: isAnything(tool),
  })
  const unlistedCodecs = codecsOf(undefined)
  const codecsByName = HashMap.fromIterable(tools.map((t) => [t.name, codecsOf(t)] as const))
  const codecs = (name: string) =>
    Option.getOrElse(HashMap.get(codecsByName, name), () => unlistedCodecs)

  const interrupt = Schema.Union([
    ...tools.map((t) =>
      Schema.Struct({ ...Event.Interrupt.fields, name: listed(t.name), input: inputCodec(t) }),
    ),
    Schema.Struct({ ...Event.Interrupt.fields, name: unlisted(toolNames) }),
  ])

  const toolInput = (event: typeof Event.ToolCallReady | typeof Event.ToolApprovalRequested) =>
    Schema.Union([
      ...tools.map((t) =>
        Schema.Struct({ ...event.fields, name: listed(t.name), input: inputCodec(t) }),
      ),
      Schema.Struct({ ...event.fields, name: unlisted(toolNames) }),
    ])

  const named = (
    event: typeof Event.Data | typeof Event.Live,
    members: ReadonlyArray<readonly [string, AnyCodec]>,
  ) =>
    Schema.Union([
      ...members.map(([name, schema]) =>
        Schema.Struct({ ...event.fields, name: listed(name), value: json(schema) }),
      ),
      Schema.Struct({ ...event.fields, name: unlisted(members.map(([name]) => name)) }),
    ])

  const event = Schema.Union([
    ...Event.plainEvents.map((e) => Schema.toType(e)),
    Schema.Struct({ ...Event.RunCompleted.fields, metadata: Schema.optional(metadata) }),
    Schema.Struct({ ...Event.RunInterrupted.fields, interrupts: Schema.Array(interrupt) }),
    Schema.Union([
      ...objects.map(([name, schema]) =>
        Schema.Struct({ ...Event.ObjectDone.fields, name: listed(name), value: json(schema) }),
      ),
      Schema.Struct({
        ...Event.ObjectDone.fields,
        name: Schema.optional(unlisted(objects.map(([name]) => name))),
      }),
    ]),
    toolInput(Event.ToolCallReady),
    toolInput(Event.ToolApprovalRequested),
    Schema.Union([
      ...tools.map((t) =>
        Schema.Struct({ ...Event.ToolPartial.fields, name: listed(t.name), value: outputCodec(t) }),
      ),
      Schema.Struct({ ...Event.ToolPartial.fields, name: unlisted(toolNames) }),
    ]),
    Schema.Union([
      ...tools.map((t) =>
        Schema.Struct({ ...Event.ToolResult.fields, name: listed(t.name), result: resultCodec(t) }),
      ),
      Schema.Struct({ ...Event.ToolResult.fields, name: unlisted(toolNames) }),
    ]),
    named(Event.Data, data),
    named(Event.Live, live),
  ])
  const envelope = Schema.Struct({ ...Event.envelopeFields, event })

  const view = RunView.schema({
    block: Schema.Union([
      ...RunView.contentBlocks,
      ...tools.map((t) =>
        RunView.toolBlock(listed(t.name), inputCodec(t), outputCodec(t), failureCodec(t)),
      ),
      RunView.toolBlock(unlisted(toolNames), Schema.Json, Schema.Json, Schema.Json),
      ...objects.map(([name, schema]) => RunView.objectBlock(listed(name), json(schema))),
      RunView.objectBlock(unlisted(objects.map(([name]) => name)), Schema.Json),
      RunView.unnamedObject,
      ...data.map(([name, schema]) => RunView.dataBlock(listed(name), json(schema))),
      RunView.dataBlock(unlisted(data.map(([name]) => name)), Schema.Json),
    ]),
    interrupt,
    // Unlisted live values are transient and untyped: the schema keeps listed ones only.
    live: Schema.Struct(
      Object.fromEntries(live.map(([name, schema]) => [name, Schema.optionalKey(json(schema))])),
    ),
    metadata,
  })

  const codecOf = (members: ReadonlyArray<readonly [string, AnyCodec]>, name: string) =>
    members.find(([n]) => n === name)?.[1]
  const encode = (schema: AnyCodec | undefined, value: unknown) =>
    Schema.encodeUnknownEffect(schema === undefined ? Schema.Json : json(schema))(value).pipe(
      Effect.flatMap(toJson),
    )
  const toolResult = (call: Call, outcome: Event.Outcome<unknown, unknown>) =>
    Schema.encodeUnknownEffect(codecs(call.name).result)(outcome).pipe(
      Effect.flatMap(toOutcome),
      Effect.map((result): RunEvent => ({
        type: "tool-result",
        callId: call.call_id,
        name: call.name,
        result,
      })),
    )

  return {
    decode: Schema.decodeUnknownEffect(envelope),
    Envelope: envelope,
    RunView: view,
    Thread: Thread.State(Thread.UserContent, view, view),
    data: (name, value, options) =>
      encode(codecOf(data, name), value).pipe(
        Effect.map((encoded): RunEvent =>
          options?.id === undefined
            ? { type: "data", name, value: encoded }
            : { type: "data", name, value: encoded, id: options.id },
        ),
      ),
    live: (name, value) =>
      encode(codecOf(live, name), value).pipe(
        Effect.map((encoded): RunEvent => ({ type: "live", name, value: encoded })),
      ),
    metadata: (value) => encode(spec.metadata, value),
    toolEvent: (event) =>
      Match.value(event).pipe(
        Match.tagsExhaustive({
          Partial: (e) =>
            Schema.encodeUnknownEffect(codecs(e.tool).output)(e.value).pipe(
              Effect.flatMap(toJson),
              Effect.map((value): RunEvent => ({
                type: "tool-partial",
                callId: e.call_id,
                name: e.tool,
                value,
              })),
            ),
          Output: (e) =>
            toolResult(
              { call_id: e.call_id, name: e.tool },
              Result.match(e.result, {
                onSuccess: (value): Event.Outcome<unknown, unknown> => ({ _tag: "Success", value }),
                onFailure: (error): Event.Outcome<unknown, unknown> => ({ _tag: "Failure", error }),
              }),
            ),
        }),
      ),
    // The item holds the encoded value: "anything" goes as its parts, the rest as the JSON they encode.
    toolOutput: (item, name) =>
      Match.value(item).pipe(
        Match.when({ isError: true }, (o) =>
          Effect.map(ToolOutput.encoded(o.output), (error) => ({ _tag: "Failure", error })),
        ),
        Match.orElse((o) =>
          Effect.map(
            codecs(name).anything ? encodeParts(o.output) : ToolOutput.encoded(o.output),
            (value) => ({ _tag: "Success", value }),
          ),
        ),
        Effect.flatMap(toOutcome),
        Effect.map((result): RunEvent => ({
          type: "tool-result",
          callId: item.call_id,
          name,
          result,
        })),
      ),
    success: (call, value) => toolResult(call, { _tag: "Success", value }),
    failure: (call, error) => toolResult(call, { _tag: "Failure", error }),
  }
}
