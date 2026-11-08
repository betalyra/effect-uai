import type { StandardSchemaV1 } from "@standard-schema/spec"
import {
  Array as Arr,
  Cause,
  Data,
  Effect,
  Function,
  Match,
  Option,
  Predicate,
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
  isStreamed,
  toDescriptors,
  toStream,
  withFailures as withToolFailures,
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
 * `wrap` runs first. The middleware sees a stream; an `Effect` tool stays one,
 * with the stream's last value.
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
    mapLocal(toolkit, (tool) => {
      const wrapped = middleware((input: unknown) => toStream(tool.run(input)), tool.name)
      // Keeps the shape: an `Effect` tool stays single-valued, so it emits no partials.
      return {
        ...tool,
        run: (input: unknown) =>
          isStreamed(tool.run(input)) ? wrapped(input) : lastOf(tool.name, wrapped(input)),
      }
    }),
)

const lastOf = <A, E, R>(name: string, values: Stream.Stream<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Stream.runLast(values),
    Option.match({
      onSome: Effect.succeed,
      onNone: () => Effect.die(`A middleware left the Effect tool "${name}" without a value`),
    }),
  )

type AddFailures<T extends AnyTool, F2> =
  T extends Tool<infer N, infer I, infer O, infer F, infer E, infer R>
    ? Tool<N, I, O, F | F2, E, R>
    : T

type AddFailuresToolkit<T extends ToolMap, F2> = {
  readonly [K in keyof T]: T[K] extends AnyTool ? AddFailures<T[K], F2> : T[K]
}

/**
 * `Tool.withFailures` for every local tool, e.g. a whole MCP toolkit that needs
 * approval. Prefer it per tool when only some tools are gated.
 */
export const withFailures: {
  <F2, F2Encoded extends Schema.Json>(
    failures: Schema.Codec<F2, F2Encoded>,
  ): <T extends Toolkit>(toolkit: T) => AddFailuresToolkit<T, F2>
  <T extends Toolkit, F2, F2Encoded extends Schema.Json>(
    toolkit: T,
    failures: Schema.Codec<F2, F2Encoded>,
  ): AddFailuresToolkit<T, F2>
} = Function.dual(
  2,
  <T extends Toolkit, F2>(
    toolkit: T,
    failures: Schema.Codec<F2, Schema.Json>,
  ): AddFailuresToolkit<T, F2> => mapLocal(toolkit, (tool) => withToolFailures(tool, failures)),
)

// `D` is what `describe` returns: with `undefined` possible, some errors stay on the stream.
type DescribeTool<T extends AnyTool, D> =
  T extends Tool<infer N, infer I, infer O, infer F, infer E, infer R>
    ? Tool<N, I, O, F | ToolFailed, F | ToolFailed | (undefined extends D ? E : never), R>
    : T

type DescribeToolkit<T extends ToolMap, D> = {
  readonly [K in keyof T]: T[K] extends AnyTool ? DescribeTool<T[K], D> : T[K]
}

/**
 * Undeclared errors become a `ToolFailed` the model reads, e.g. with
 * `AiError.describe`. Declared failures pass through unchanged. Return
 * `undefined` for an error that should still fail the run (a dead session).
 */
export const describeFailures: {
  <E, D extends string | undefined>(
    describe: (e: E) => D,
  ): <T extends Toolkit>(toolkit: T) => DescribeToolkit<T, D>
  <T extends Toolkit, D extends string | undefined>(
    toolkit: T,
    describe: (e: ToolkitE<T>) => D,
  ): DescribeToolkit<T, D>
} = Function.dual(
  2,
  <T extends Toolkit>(
    toolkit: T,
    describe: (e: unknown) => string | undefined,
  ): DescribeToolkit<T, string | undefined> =>
    mapLocal(toolkit, (tool) => {
      const isDeclared = isDeclaredBy(tool)
      const toFailed = (e: unknown) =>
        isDeclared(e)
          ? e
          : Option.match(Option.fromNullishOr(describe(e)), {
              onNone: () => e,
              onSome: (message) => new ToolFailed({ message }),
            })
      return {
        ...tool,
        failureSchema:
          tool.failureSchema === undefined
            ? ToolFailed
            : Schema.Union([tool.failureSchema, ToolFailed]),
        // Keeps the shape: an `Effect` tool must not start emitting partials.
        run: (input: unknown) => {
          const out = tool.run(input)
          return isStreamed(out) ? Stream.mapError(out, toFailed) : Effect.mapError(out, toFailed)
        },
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

// An `Effect` tool emits its `Output`. A `Stream` tool emits each value as a
// `Partial` as it arrives, then the last one again as the `Output`. Each value
// is checked against `outputSchema` and handed on decoded.
const execute = (
  tool: AnyLocalTool,
  call: ToolCall,
  input: unknown,
): Stream.Stream<AnyEvent, unknown, any> => {
  const out = tool.run(input)
  const events = isStreamed(out)
    ? streamed(tool, call, out)
    : Stream.fromEffect(
        Effect.map(
          Effect.tap(out, (value) => check(tool, value)),
          (value) => done(call, Result.succeed(value)),
        ),
      )
  return Stream.catchCause(events, (cause) =>
    Stream.fromEffect(Effect.map(declared(tool, cause), (error) => done(call, Result.fail(error)))),
  )
}

const streamed = (
  tool: AnyLocalTool,
  call: ToolCall,
  values: Stream.Stream<unknown, unknown, unknown>,
): Stream.Stream<AnyEvent, unknown, unknown> =>
  values.pipe(
    Stream.mapEffect((value) => Effect.as(check(tool, value), Option.some(value))),
    // `None` marks a clean end: `concat` never runs after a failure, so a
    // failing tool can't have its last partial promoted to a `Success`.
    Stream.concat(Stream.succeed(Option.none<unknown>())),
    Stream.mapAccum(
      () => Option.none<unknown>(),
      (last, next): readonly [Option.Option<unknown>, ReadonlyArray<AnyEvent>] =>
        Option.match(next, {
          onSome: (value) => [
            Option.some(value),
            [{ _tag: "Partial", call_id: call.call_id, tool: tool.name, value }],
          ],
          onNone: () => [
            last,
            [
              done(
                call,
                Option.match(last, {
                  onNone: () =>
                    Result.fail(new OutputInvalid({ message: "The tool produced no value" })),
                  onSome: Result.succeed,
                }),
              ),
            ],
          ],
        }),
    ),
  )

// Marks a value `outputSchema` rejected, apart from the tool's own errors
// (matched by class, so a tool error with the same tag can't pose as one).
class EncodeFailed extends Data.TaggedError("EncodeFailed")<{ readonly message: string }> {}

const check = (tool: AnyLocalTool, value: unknown): Effect.Effect<unknown, EncodeFailed> =>
  tool.outputSchema === undefined
    ? Effect.void
    : Schema.encodeUnknownEffect(tool.outputSchema)(value).pipe(
        Effect.mapError((e) => new EncodeFailed({ message: e.message.slice(0, 500) })),
      )

const isDeclaredBy = (tool: AnyLocalTool): ((e: unknown) => boolean) =>
  tool.failureSchema === undefined ? () => false : Schema.is(tool.failureSchema)

// The error of a cause holding exactly one failure; `None` for anything mixed.
const soleError = (cause: Cause.Cause<unknown>): Option.Option<unknown> =>
  Option.fromNullishOr(cause.reasons.length === 1 ? cause.reasons[0] : undefined).pipe(
    Option.filter(Cause.isFailReason),
    Option.map((reason) => reason.error),
  )

// One failure the tool declared (or a rejected value) becomes a `Failure`.
// Anything else (undeclared errors, defects, interruption) propagates.
const declared = (
  tool: AnyLocalTool,
  cause: Cause.Cause<unknown>,
): Effect.Effect<unknown, unknown> =>
  soleError(cause).pipe(
    Option.flatMap((error) =>
      Match.value(error).pipe(
        Match.when(Match.instanceOf(EncodeFailed), (e) =>
          Option.some<unknown>(new OutputInvalid({ message: e.message })),
        ),
        Match.when(isDeclaredBy(tool), Option.some),
        Match.orElse(() => Option.none()),
      ),
    ),
    Option.match({ onNone: () => Effect.failCause(cause), onSome: Effect.succeed }),
  )

// ---------------------------------------------------------------------------
// To history and back
// ---------------------------------------------------------------------------

const outputs = (tool: AnyLocalTool | undefined): Schema.Codec<unknown, Schema.Json> =>
  tool?.outputSchema ?? Content.Value

const failures = (tool: AnyLocalTool | undefined): Schema.Codec<unknown, Schema.Json> =>
  tool?.failureSchema === undefined ? CoreError : Schema.Union([tool.failureSchema, CoreError])

/** Any call's outcome, as `run` emits it. */
export type Outcome = ToolEvent.Output<string, unknown, unknown>

/** Every error the toolkit's tools declare (core's errors are always possible too). */
export type ToolkitFailure<T extends Toolkit> = ToolMap extends T
  ? unknown
  : ToolFailure<T[keyof T]>

/** `Toolkit.close` got an error the call's tool doesn't declare: a bug in the app. */
export class UndeclaredFailure extends Data.TaggedError("UndeclaredFailure")<{
  readonly tool: string
  readonly message: string
}> {}

const describeError = (error: unknown): string =>
  Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)
    ? error._tag
    : String(error)

/**
 * A call the app closes itself (denied, superseded), as the outcome `run`
 * would emit. `error` must be core's or declared by the call's tool
 * (`failureSchema`, `Tool.withFailures`), else this fails with `UndeclaredFailure`.
 */
export const close = <T extends Toolkit>(
  toolkit: T,
  call: ToolCall,
  error: ToolkitFailure<T> | CoreError,
): Effect.Effect<
  ToolEvent.Output<string, never, ToolkitFailure<T> | CoreError>,
  UndeclaredFailure
> =>
  Schema.is(failures(local(toolkit, call.name)))(error)
    ? Effect.succeed({
        _tag: "Output",
        call_id: call.call_id,
        tool: call.name,
        result: Result.fail(error),
      })
    : Effect.fail(
        new UndeclaredFailure({
          tool: call.name,
          message: `"${call.name}" does not declare ${describeError(error)} in its failureSchema`,
        }),
      )

/** Narrows to the `Output` members (also in a loop's mixed stream), keeping the per-tool types. */
export const isOutcome = <A extends { readonly _tag: string }>(
  e: A,
): e is Extract<A, { readonly _tag: "Output" }> => e._tag === "Output"

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
  return Match.value(item).pipe(
    Match.when({ isError: true }, () => Effect.map(decodeWith(failures(tool)), Result.fail)),
    Match.orElse(() =>
      Option.match(Option.fromNullishOr(tool?.outputSchema), {
        // Without `outputSchema` the parts' own types say what the value is.
        onNone: () => Effect.succeed(Result.succeed(ToolOutput.value(item.output))),
        onSome: (schema) => Effect.map(decodeWith(schema), Result.succeed),
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// Into the loop
// ---------------------------------------------------------------------------

type Tagged = { readonly _tag: string }

// An app's own events may travel alongside; `Output` is reserved for outcomes.
const isOutcomeOf = <A extends Tagged>(e: A): e is A & Outcome => e._tag === "Output"

/**
 * Forward every event as a `Loop.value`, then continue the loop with
 * `build(outcomes)`. `build` is an Effect, so it can encode. The stream may
 * carry the app's own tagged events too (any tag but `Output`).
 */
export const continueWith: {
  <S, E2, R2>(
    build: (outcomes: ReadonlyArray<Outcome>) => Effect.Effect<S, E2, R2>,
  ): <A extends Tagged, E, R>(
    stream: Stream.Stream<A, E, R>,
  ) => Stream.Stream<Loop.Step<A, S>, E | E2, R | R2>
  <A extends Tagged, E, R, S, E2, R2>(
    stream: Stream.Stream<A, E, R>,
    build: (outcomes: ReadonlyArray<Outcome>) => Effect.Effect<S, E2, R2>,
  ): Stream.Stream<Loop.Step<A, S>, E | E2, R | R2>
} = Function.dual(
  2,
  <A extends Tagged, E, R, S, E2, R2>(
    stream: Stream.Stream<A, E, R>,
    build: (outcomes: ReadonlyArray<Outcome>) => Effect.Effect<S, E2, R2>,
  ): Stream.Stream<Loop.Step<A, S>, E | E2, R | R2> =>
    Stream.unwrap(
      Effect.map(Ref.make<ReadonlyArray<Outcome>>([]), (outcomes) =>
        Stream.concat(
          stream.pipe(
            Stream.tap((e) =>
              isOutcomeOf(e) ? Ref.update(outcomes, Arr.append<Outcome>(e)) : Effect.void,
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
