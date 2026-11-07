import type { StandardSchemaV1 } from "@standard-schema/spec"
import {
  Array as Arr,
  Cause,
  Data,
  Effect,
  Function,
  Match,
  Option,
  Record,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect"
import type { HistoryItem, ToolCall, ToolCallOutput } from "../domain/Items.js"
import { appendToHistory, type Turn } from "../domain/Turn.js"
import * as Loop from "../loop/Loop.js"
import * as Content from "./Content.js"
import {
  type AnyLocalTool,
  type AnyTool,
  type DecodeResult,
  type Declared,
  decodeCallInput,
  type ProviderTool,
  type Tool,
  type ToolDescriptor,
  ToolFailed,
  type ToolFailure,
  type ToolOutput as OutputOf,
  type ToolR,
  type ToolUnhandled,
  toDescriptors,
  toStream,
} from "./Tool.js"
import type * as ToolEvent from "./ToolEvent.js"
import * as ToolOutput from "./ToolOutput.js"
import { CoreError, InputInvalid, OutputInvalid, type RunError, UnknownTool } from "./ToolOutput.js"

// ---------------------------------------------------------------------------
// Toolkit: a name-indexed record of tools, what the model sees. `make` checks
// duplicate names at compile time, `fromArray` takes a dynamic source
// (last wins), `compose` joins independent toolkits and fails on clashes.
// ---------------------------------------------------------------------------

export type ToolMap = Record<string, AnyTool>

export type Toolkit<Tools extends ToolMap = ToolMap> = Tools

type Indexed<Tools extends ReadonlyArray<AnyTool>> = { [T in Tools[number] as T["name"]]: T }

const indexByName = (tools: ReadonlyArray<AnyTool>): ToolMap =>
  Object.fromEntries(tools.map((tool) => [tool.name, tool]))

const buildStatic = <Tools extends ReadonlyArray<AnyTool>>(tools: Tools): Toolkit<Indexed<Tools>> =>
  indexByName(tools) as Toolkit<Indexed<Tools>>

/** Index tools by `name`. A repeated literal name is a compile error. */
export const make = <const Tools extends ReadonlyArray<AnyTool>>(
  ...tools: UniqueTools<Tools>
): Toolkit<Indexed<Tools>> => buildStatic<Tools>(tools)

/** A toolkit from a dynamic source (MCP server, plugin). Same-named tools: last wins. */
export const fromArray = (tools: ReadonlyArray<AnyTool>): Toolkit => indexByName(tools)

export const descriptors = (toolkit: Toolkit): ReadonlyArray<ToolDescriptor> =>
  toDescriptors(Object.values(toolkit))

// A wide `Toolkit` (types unknown statically) yields `never`, not `any`.
type Locals<T extends Toolkit> = Extract<T[keyof T], { readonly _tag: "LocalTool" }>

/** Every tool's requirements. */
export type ToolkitR<T extends Toolkit> = ToolMap extends T ? never : ToolR<T[keyof T]>

/** Every error a tool did not declare in `failureSchema`: these fail `run`'s stream. */
export type ToolkitE<T extends Toolkit> = ToolMap extends T ? never : ToolUnhandled<T[keyof T]>

/** What `run` emits: one member per local tool, plus calls it could not run at all. */
export type Event<T extends Toolkit> =
  | (Locals<T> extends infer X
      ? X extends Tool<infer N, any, infer O, infer F, any, any>
        ? ToolEvent.ToolEvent<N, O, F | RunError>
        : never
      : never)
  | ToolEvent.Output<string, never, RunError>

// ---------------------------------------------------------------------------
// Uniqueness and composition
// ---------------------------------------------------------------------------

type DuplicateName<
  Tools extends ReadonlyArray<AnyTool>,
  Seen extends string = never,
> = Tools extends readonly [
  infer Head extends AnyTool,
  ...infer Tail extends ReadonlyArray<AnyTool>,
]
  ? Head["name"] extends Seen
    ? Head["name"]
    : DuplicateName<Tail, Seen | Head["name"]>
  : never

type DuplicateNameError<Name extends string> = {
  readonly __error: `Duplicate tool name: ${Name}`
}

export type NoDuplicateNames<Tools extends ReadonlyArray<AnyTool>> = [
  DuplicateName<Tools>,
] extends [never]
  ? unknown
  : DuplicateNameError<DuplicateName<Tools>>

export type UniqueTools<Tools extends ReadonlyArray<AnyTool>> = Tools & NoDuplicateNames<Tools>

// Skips wide (`string`-keyed) toolkits so `fromArray` never false-positives.
type ComposeDuplicateKey<
  Kits extends ReadonlyArray<Toolkit>,
  Seen extends string = never,
> = Kits extends readonly [infer Head extends Toolkit, ...infer Tail extends ReadonlyArray<Toolkit>]
  ? string extends keyof Head
    ? ComposeDuplicateKey<Tail, Seen>
    : Extract<keyof Head & string, Seen> extends never
      ? ComposeDuplicateKey<Tail, Seen | (keyof Head & string)>
      : Extract<keyof Head & string, Seen>
  : never

type NoDuplicateComposedKeys<Kits extends ReadonlyArray<Toolkit>> = [
  ComposeDuplicateKey<Kits>,
] extends [never]
  ? unknown
  : DuplicateNameError<ComposeDuplicateKey<Kits>>

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never

type Composed<Kits extends ReadonlyArray<Toolkit>> =
  UnionToIntersection<Kits[number]> extends infer M ? (M extends ToolMap ? M : ToolMap) : ToolMap

/** Two composed toolkits share a final name; `sources` are their positions. */
export class DuplicateToolName extends Data.TaggedError("DuplicateToolName")<{
  readonly name: string
  readonly sources: ReadonlyArray<string>
}> {}

type PrefixName<Prefix extends string, Name extends string> = `${Prefix}__${Name}`

type PrefixTool<Prefix extends string, T extends AnyTool> =
  T extends Tool<infer N, infer I, infer O, infer F, infer E, infer R>
    ? Tool<PrefixName<Prefix, N>, I, O, F, E, R>
    : T extends ProviderTool<infer N, infer I, infer P, infer C>
      ? ProviderTool<PrefixName<Prefix, N>, I, P, C>
      : T extends Declared<infer N, infer I>
        ? Declared<PrefixName<Prefix, N>, I>
        : T

type Namespaced<Prefix extends string, T extends ToolMap> = {
  readonly [K in keyof T & string as PrefixName<Prefix, K>]: T[K] extends AnyTool
    ? PrefixTool<Prefix, T[K]>
    : never
}

/** Prefix every tool name with `<namespace>__`, e.g. to keep two `search` tools apart. */
export const namespace = <const Prefix extends string, const T extends ToolMap>(
  prefix: Prefix,
  toolkit: Toolkit<T>,
): Toolkit<Namespaced<Prefix, T>> =>
  indexByName(
    Arr.map(Record.values(toolkit), (tool) => ({ ...tool, name: `${prefix}__${tool.name}` })),
  ) as Toolkit<Namespaced<Prefix, T>>

/** `namespace(prefix, make(...tools))` in one step. */
export const makeNamespaced = <
  const Prefix extends string,
  const Tools extends ReadonlyArray<AnyTool>,
>(
  prefix: Prefix,
  ...tools: UniqueTools<Tools>
): Toolkit<Namespaced<Prefix, Indexed<Tools>>> => namespace(prefix, buildStatic<Tools>(tools))

/**
 * Join independently built toolkits. A duplicate final name fails with
 * `DuplicateToolName`; statically known duplicates are a compile error too.
 */
export const compose = <const Kits extends ReadonlyArray<Toolkit>>(
  ...toolkits: Kits & NoDuplicateComposedKeys<Kits>
): Effect.Effect<Toolkit<Composed<Kits>>, DuplicateToolName> => {
  const kits: ReadonlyArray<Toolkit> = toolkits
  const labelled = Arr.flatMap(kits, (kit, i) =>
    Arr.map(Record.keys(kit), (name) => ({ name, source: `toolkit-${i}` })),
  )
  return Arr.findFirst(
    Record.toEntries(Arr.groupBy(labelled, (entry) => entry.name)),
    ([, group]) => group.length > 1,
  ).pipe(
    Option.match({
      onNone: () =>
        Effect.succeed(
          Arr.reduce(kits, {}, (acc: ToolMap, kit) => ({ ...acc, ...kit })) as Toolkit<
            Composed<Kits>
          >,
        ),
      onSome: ([name, group]) =>
        Effect.fail(new DuplicateToolName({ name, sources: Arr.map(group, (e) => e.source) })),
    }),
  )
}

// ---------------------------------------------------------------------------
// Middleware: transforms each local tool's `run`, seen as a stream (an `Effect`
// run is a one-element stream), and tracks the added `R2` / `E2`.
// ---------------------------------------------------------------------------

export type Handler<Input, Output, E, R> = (input: Input) => Stream.Stream<Output, E, R>

export type Middleware<R2 = never, E2 = never> = <Input, Output, E, R>(
  run: Handler<Input, Output, E, R>,
  name: string,
) => Handler<Input, Output, E | E2, R | R2>

type WrapTool<T extends AnyTool, R2, E2> =
  T extends Tool<infer N, infer I, infer O, infer F, infer E, infer R>
    ? Tool<N, I, O, F, E | E2, R | R2>
    : T

type WrapToolkit<T extends ToolMap, R2, E2> = {
  readonly [K in keyof T]: T[K] extends AnyTool ? WrapTool<T[K], R2, E2> : T[K]
}

const mapLocal = <T extends Toolkit, Out>(
  toolkit: T,
  f: (tool: AnyLocalTool) => AnyLocalTool,
): Out => Record.map(toolkit, (tool) => (tool._tag === "LocalTool" ? f(tool) : tool)) as Out

/**
 * Wrap every local tool's `run`. Stacks with `pipe`, inner first: the last
 * `wrap` runs first.
 *
 *   const observed = pipe(toolkit, Toolkit.wrap(logging), Toolkit.wrap(authz))
 */
export const wrap: {
  <R2, E2>(
    middleware: Middleware<R2, E2>,
  ): <T extends Toolkit>(toolkit: T) => WrapToolkit<T, R2, E2>
  <T extends Toolkit, R2, E2>(toolkit: T, middleware: Middleware<R2, E2>): WrapToolkit<T, R2, E2>
} = Function.dual(
  2,
  <T extends Toolkit, R2, E2>(toolkit: T, middleware: Middleware<R2, E2>): WrapToolkit<T, R2, E2> =>
    mapLocal(toolkit, (tool) => ({
      ...tool,
      run: middleware((input: unknown) => toStream(tool.run(input)), tool.name),
    })),
)

type DescribeTool<T extends AnyTool> =
  T extends Tool<infer N, infer I, infer O, infer F, any, infer R>
    ? Tool<N, I, O, F | ToolFailed, F | ToolFailed, R>
    : T

type DescribeToolkit<T extends ToolMap> = {
  readonly [K in keyof T]: T[K] extends AnyTool ? DescribeTool<T[K]> : T[K]
}

/**
 * Every undeclared error becomes a `ToolFailed` the model reads, e.g. with
 * `AiError.describe`. Declared failures pass through unchanged.
 */
export const describeFailures: {
  <E>(describe: (e: E) => string): <T extends Toolkit>(toolkit: T) => DescribeToolkit<T>
  <T extends Toolkit>(toolkit: T, describe: (e: ToolkitE<T>) => string): DescribeToolkit<T>
} = Function.dual(
  2,
  <T extends Toolkit>(toolkit: T, describe: (e: unknown) => string): DescribeToolkit<T> =>
    mapLocal(toolkit, (tool) => {
      const isDeclared: (e: unknown) => boolean =
        tool.failureSchema === undefined ? () => false : Schema.is(tool.failureSchema)
      const toFailed = (e: unknown) =>
        isDeclared(e) ? e : new ToolFailed({ message: describe(e) })
      return {
        ...tool,
        failureSchema:
          tool.failureSchema === undefined
            ? ToolFailed
            : Schema.Union([tool.failureSchema, ToolFailed]),
        run: (input: unknown) => Stream.mapError(toStream(tool.run(input)), toFailed),
      }
    }),
)

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export type ExecuteOptions = {
  readonly concurrency?: number | "unbounded"
}

/**
 * Run the calls, emitting each one's partials and its `Output`, typed per tool
 * and decoded. An error matching the tool's `failureSchema` becomes a `Failure`;
 * any other error fails the stream (siblings of a failed batch may then stay
 * unanswered: see `HistoryCheck.cancelAllPending`). Which calls run is the caller's call.
 */
export const run = <T extends Toolkit>(
  toolkit: T,
  calls: ReadonlyArray<ToolCall>,
  options?: ExecuteOptions,
): Stream.Stream<Event<T>, ToolkitE<T>, ToolkitR<T>> =>
  Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) => runOne(toolkit, call), {
      concurrency: options?.concurrency ?? "unbounded",
    }),
  ) as Stream.Stream<Event<T>, ToolkitE<T>, ToolkitR<T>>

type AnyEvent = ToolEvent.ToolEvent<string, unknown, unknown>

// Own-property lookup: a call named `constructor` must not hit the prototype.
const lookup = (toolkit: Toolkit, name: string): AnyTool | undefined =>
  Object.hasOwn(toolkit, name) ? toolkit[name] : undefined

const local = (toolkit: Toolkit, name: string): AnyLocalTool | undefined => {
  const tool = lookup(toolkit, name)
  return tool?._tag === "LocalTool" ? tool : undefined
}

const done = (call: ToolCall, result: Result.Result<unknown, unknown>): AnyEvent => ({
  _tag: "Output",
  call_id: call.call_id,
  tool: call.name,
  result,
})

const failWith = (call: ToolCall, error: RunError): Stream.Stream<AnyEvent> =>
  Stream.succeed(done(call, Result.fail(error)))

const runOne = (toolkit: Toolkit, call: ToolCall): Stream.Stream<AnyEvent, unknown, any> =>
  Match.value(lookup(toolkit, call.name)).pipe(
    Match.when(Match.undefined, () =>
      failWith(call, new UnknownTool({ message: `No tool named "${call.name}"` })),
    ),
    Match.tag("LocalTool", (tool) => runTool(tool, call)),
    Match.orElse(() =>
      failWith(call, new UnknownTool({ message: `"${call.name}" is not a local tool` })),
    ),
  )

const describeIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((seg) => (typeof seg === "object" && seg !== null ? String(seg.key) : String(seg)))
        .join(".")
      return path === "" ? issue.message : `${path}: ${issue.message}`
    })
    .join("; ")
    .slice(0, 500)

const runTool = (tool: AnyLocalTool, call: ToolCall): Stream.Stream<AnyEvent, unknown, any> =>
  Stream.unwrap(
    Effect.map(
      decodeCallInput(tool, call),
      Match.type<DecodeResult<unknown>>().pipe(
        Match.tag("parseError", () =>
          failWith(call, new InputInvalid({ message: "arguments are not valid JSON" })),
        ),
        Match.tag("invalid", ({ issues }) =>
          failWith(call, new InputInvalid({ message: describeIssues(issues) })),
        ),
        Match.tag("ok", ({ input }) => execute(tool, call, input)),
        Match.exhaustive,
      ),
    ),
  )

// Every element but the last is a `Partial`; the last is the `Success`. Each
// value is checked against `outputSchema` and handed on decoded.
const execute = (
  tool: AnyLocalTool,
  call: ToolCall,
  input: unknown,
): Stream.Stream<AnyEvent, unknown, any> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const last = yield* Ref.make(Option.none<unknown>())
      const partials = toStream(tool.run(input)).pipe(
        Stream.mapEffect((value) => Effect.as(check(tool, value), value)),
        Stream.mapEffect((value) => Ref.getAndSet(last, Option.some(value))),
        Stream.filterMap((previous) => Result.fromOption(previous, () => undefined)),
        Stream.map((value): AnyEvent => ({
          _tag: "Partial",
          call_id: call.call_id,
          tool: tool.name,
          value,
        })),
      )
      const final = Effect.map(
        Ref.get(last),
        Option.match({
          onNone: () => Result.fail(new OutputInvalid({ message: "The tool produced no value" })),
          onSome: Result.succeed,
        }),
      )
      return partials.pipe(
        Stream.concat(Stream.fromEffect(Effect.map(final, (result) => done(call, result)))),
        Stream.catchCause((cause) =>
          Stream.fromEffect(
            Effect.map(declared(tool, cause), (error) => done(call, Result.fail(error))),
          ),
        ),
      )
    }),
  )

// Marks a value `outputSchema` rejected, apart from the tool's own errors.
class EncodeFailed {
  constructor(readonly message: string) {}
}

const check = (tool: AnyLocalTool, value: unknown): Effect.Effect<unknown, EncodeFailed> =>
  tool.outputSchema === undefined
    ? Effect.void
    : Schema.encodeUnknownEffect(tool.outputSchema)(value).pipe(
        Effect.mapError((e) => new EncodeFailed(e.message.slice(0, 500))),
      )

// One failure the tool declared (or a rejected value) becomes a `Failure`.
// Anything else (undeclared errors, defects, interruption) propagates.
const declared = (
  tool: AnyLocalTool,
  cause: Cause.Cause<unknown>,
): Effect.Effect<unknown, unknown> => {
  const only = cause.reasons.length === 1 ? cause.reasons[0] : undefined
  if (only === undefined || !Cause.isFailReason(only)) return Effect.failCause(cause)
  if (only.error instanceof EncodeFailed) {
    return Effect.succeed(new OutputInvalid({ message: only.error.message }))
  }
  return tool.failureSchema !== undefined && Schema.is(tool.failureSchema)(only.error)
    ? Effect.succeed(only.error)
    : Effect.failCause(cause)
}

// ---------------------------------------------------------------------------
// To history and back
// ---------------------------------------------------------------------------

const outputs = (tool: AnyLocalTool | undefined): Schema.Codec<unknown, Schema.Json> =>
  tool?.outputSchema ?? Content.Value

const failures = (tool: AnyLocalTool | undefined): Schema.Codec<unknown, Schema.Json> =>
  tool?.failureSchema === undefined ? CoreError : Schema.Union([tool.failureSchema, CoreError])

/** Any call's outcome, as `run` emits it. */
export type Outcome = ToolEvent.Output<string, unknown, unknown>

/** Narrows `Event<T>` to its `Output` members, keeping the per-tool types. */
export const isOutcome = <A extends AnyEvent>(e: A): e is Extract<A, { readonly _tag: "Output" }> =>
  e._tag === "Output"

const toOutput = (
  toolkit: Toolkit,
  event: Outcome,
): Effect.Effect<ToolCallOutput, Schema.SchemaError> => {
  const tool = local(toolkit, event.tool)
  return Result.match(event.result, {
    onSuccess: (value) => ToolOutput.success(event, outputs(tool), value),
    onFailure: (error) => ToolOutput.failure(event, failures(tool), error),
  })
}

/**
 * An outcome as history, encoded with the tool's schemas (never stringified:
 * that is the provider codec's job). `output(toolkit)` is the pipeable form.
 */
export function output(
  toolkit: Toolkit,
): (event: Outcome) => Effect.Effect<ToolCallOutput, Schema.SchemaError>
export function output(
  toolkit: Toolkit,
  event: Outcome,
): Effect.Effect<ToolCallOutput, Schema.SchemaError>
export function output(toolkit: Toolkit, event?: Outcome) {
  return event === undefined ? (e: Outcome) => toOutput(toolkit, e) : toOutput(toolkit, event)
}

/** History back to a typed `Result` for tool `name`, decoded with its schemas. */
export function decode<T extends Toolkit, N extends keyof T & string>(
  toolkit: T,
  name: N,
  item: ToolCallOutput,
): Effect.Effect<
  Result.Result<OutputOf<T[N]>, ToolFailure<T[N]> | ToolOutput.CoreError>,
  Schema.SchemaError
>
export function decode(
  toolkit: Toolkit,
  name: string,
  item: ToolCallOutput,
): Effect.Effect<Result.Result<unknown, unknown>, Schema.SchemaError> {
  const tool = local(toolkit, name)
  const decodeWith = (schema: Schema.Codec<unknown, unknown>) =>
    Effect.flatMap(ToolOutput.encoded(item.output), Schema.decodeUnknownEffect(schema))
  if (item.isError === true) return Effect.map(decodeWith(failures(tool)), Result.fail)
  return Option.match(Option.fromNullishOr(tool?.outputSchema), {
    // Without `outputSchema` the parts' own types say what the value is.
    onNone: () => Effect.succeed(Result.succeed(ToolOutput.value(item.output))),
    onSome: (schema) => Effect.map(decodeWith(schema), Result.succeed),
  })
}

// ---------------------------------------------------------------------------
// Into the loop
// ---------------------------------------------------------------------------

/**
 * Forward every event as a `Loop.value`, then continue the loop with
 * `build(outcomes)`. `build` is an Effect, so it can encode.
 */
export const continueWith: {
  <S, E2, R2>(
    build: (outcomes: ReadonlyArray<Outcome>) => Effect.Effect<S, E2, R2>,
  ): <A extends AnyEvent, E, R>(
    stream: Stream.Stream<A, E, R>,
  ) => Stream.Stream<Loop.Step<A, S>, E | E2, R | R2>
  <A extends AnyEvent, E, R, S, E2, R2>(
    stream: Stream.Stream<A, E, R>,
    build: (outcomes: ReadonlyArray<Outcome>) => Effect.Effect<S, E2, R2>,
  ): Stream.Stream<Loop.Step<A, S>, E | E2, R | R2>
} = Function.dual(
  2,
  <A extends AnyEvent, E, R, S, E2, R2>(
    stream: Stream.Stream<A, E, R>,
    build: (outcomes: ReadonlyArray<Outcome>) => Effect.Effect<S, E2, R2>,
  ): Stream.Stream<Loop.Step<A, S>, E | E2, R | R2> =>
    Stream.unwrap(
      Effect.map(Ref.make<ReadonlyArray<Outcome>>([]), (outcomes) =>
        Stream.concat(
          stream.pipe(
            Stream.tap((e) =>
              isOutcome(e) ? Ref.update(outcomes, Arr.append<Outcome>(e)) : Effect.void,
            ),
            Stream.map(Loop.value),
          ),
          Stream.unwrap(Ref.get(outcomes).pipe(Effect.flatMap(build), Effect.map(Loop.next))),
        ),
      ),
    ),
)

/** Encode each outcome with `output` and append the turn plus the outputs to history. */
export const appendResults =
  <S extends { readonly history: ReadonlyArray<HistoryItem> }>(
    toolkit: Toolkit,
    state: S,
    turn: Turn,
  ) =>
  (outcomes: ReadonlyArray<Outcome>): Effect.Effect<S, Schema.SchemaError> =>
    Effect.map(Effect.forEach(outcomes, output(toolkit)), (items) =>
      appendToHistory(state, turn, items),
    )

/** `continueWith(appendResults(toolkit, state, turn))`. */
export const next = <S extends { readonly history: ReadonlyArray<HistoryItem> }>(
  toolkit: Toolkit,
  state: S,
  turn: Turn,
) => continueWith(appendResults(toolkit, state, turn))
