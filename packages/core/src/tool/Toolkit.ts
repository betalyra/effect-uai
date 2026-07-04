import type { StandardSchemaV1 } from "@standard-schema/spec"
import {
  Array as Arr,
  Cause,
  Data,
  Effect,
  Fiber,
  Function,
  Match,
  Option,
  Queue,
  Record,
  Ref,
  Stream,
} from "effect"
import * as Loop from "../loop/Loop.js"
import type { HistoryItem, ToolCall } from "../domain/Items.js"
import { appendToHistory, type Turn } from "../domain/Turn.js"
import {
  type AnyLocalTool,
  type AnyTool,
  type DecodeResult,
  decodeCallInput,
  type Emit,
  type InteractionTool,
  type ProviderTool,
  type SignalTool,
  type Tool,
  type ToolDescriptor,
  type ToolE,
  ToolFailed,
  type ToolR,
  toDescriptors,
} from "./Tool.js"
import {
  ToolResult,
  failed,
  nonLocalTool,
  toToolCallOutput,
  validationError,
} from "./ToolResult.js"
import { ToolEvent } from "./ToolEvent.js"
import { isOutput } from "./ToolEvent.js"

// ---------------------------------------------------------------------------
// Toolkit: a name-indexed record of tools — "what the model sees". The record
// gives O(1) dispatch and within-toolkit name-uniqueness for free; descriptors
// are derived, not stored. Build a static one with `make` (compile-time
// duplicate-name check), a dynamic one with `fromArray` (trusted single source,
// last-wins), and combine independent ones with `compose` (the application
// boundary where cross-source names can clash).
// ---------------------------------------------------------------------------

export type ToolMap = Record<string, AnyTool>

export type Toolkit<Tools extends ToolMap = ToolMap> = Tools

const indexByName = (tools: ReadonlyArray<AnyTool>): ToolMap =>
  Object.fromEntries(tools.map((tool) => [tool.name, tool]))

/**
 * Index literal tools by their `name`. Duplicate names are a compile error
 * (`UniqueTools`). Names are not otherwise checked: a malformed name is a
 * developer typo in a literal that the provider rejects clearly on first use,
 * and there is no single cross-provider name rule to enforce here anyway.
 */
const buildStatic = <Tools extends ReadonlyArray<AnyTool>>(
  tools: Tools,
): Toolkit<{ [T in Tools[number] as T["name"]]: T }> =>
  indexByName(tools) as Toolkit<{ [T in Tools[number] as T["name"]]: T }>

export const make = <const Tools extends ReadonlyArray<AnyTool>>(
  ...tools: UniqueTools<Tools>
): Toolkit<{ [T in Tools[number] as T["name"]]: T }> => buildStatic(tools as unknown as Tools)

/**
 * Build a toolkit from a dynamically-sourced array (MCP server, plugin). Names
 * are not validated (MCP legitimately uses dots / >64 chars — sanitize at the
 * provider adapter); same-named tools resolve last-wins. Cross-source clashes
 * are caught by `compose`.
 */
export const fromArray = (tools: ReadonlyArray<AnyTool>): Toolkit => indexByName(tools)

/** Render the provider-facing descriptors for a toolkit on demand. */
export const descriptors = (toolkit: Toolkit): ReadonlyArray<ToolDescriptor> =>
  toDescriptors(Object.values(toolkit))

/**
 * Union of every tool's `R` requirements in a toolkit. Surfaced by `run` so the
 * loop's stream type carries the services tools need through to `Effect.provide`.
 *
 * The `ToolMap extends T` guard yields `never` for the wide `Toolkit` type (a
 * toolkit passed through an untyped boundary, where the requirements aren't
 * statically known) instead of `any`, which would otherwise poison the
 * resulting stream's `R`. Concrete toolkits from `make` keep their precise R.
 */
export type ToolkitR<T extends Toolkit> = ToolMap extends T ? never : ToolR<T[keyof T]>

/**
 * Union of every tool's `E` error type in a toolkit. `Toolkit.run` reports
 * `Exclude<ToolkitE<T>, string | ToolFailed>` on its stream: the sentinel
 * failures are absorbed into results, everything else propagates typed. The
 * same `ToolMap extends T` guard as `ToolkitR` keeps a wide toolkit at
 * `never` rather than `any`.
 */
export type ToolkitE<T extends Toolkit> = ToolMap extends T ? never : ToolE<T[keyof T]>

// ---------------------------------------------------------------------------
// Uniqueness & composition. `make` rejects duplicate literal names at compile
// time; `compose` rejects cross-source collisions — at compile time when the
// names are statically known, and at runtime (`DuplicateToolName`) for dynamic
// sources whose keys are only `string`. No silent last-wins overwrite, no late
// provider 400.
// ---------------------------------------------------------------------------

// --- compile-time duplicate detection --------------------------------------

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

/** `Tools` constrained so a repeated literal name is a compile error in `make`. */
export type UniqueTools<Tools extends ReadonlyArray<AnyTool>> = Tools & NoDuplicateNames<Tools>

// Cross-toolkit literal-key collision, skipping wide (`string`-keyed, dynamic)
// toolkits so the compile-time check never false-positives on `fromArray`.
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

// --- uniqueness error ------------------------------------------------------

/**
 * Two composed toolkits resolved to the same final name. Carries the colliding
 * `sources` (the positions of the clashing toolkits) so the error says *which*
 * inputs collided. Raised at runtime by `compose` for dynamic sources; static
 * collisions are caught earlier at compile time.
 */
export class DuplicateToolName extends Data.TaggedError("DuplicateToolName")<{
  readonly name: string
  readonly sources: ReadonlyArray<string>
}> {}

// --- namespacing -----------------------------------------------------------

type PrefixName<Prefix extends string, Name extends string> = `${Prefix}__${Name}`

type PrefixTool<Prefix extends string, T extends AnyTool> =
  T extends Tool<infer N, infer I, infer Ev, infer O, infer R>
    ? Tool<PrefixName<Prefix, N>, I, Ev, O, R>
    : T extends ProviderTool<infer N, infer I, infer P, infer C>
      ? ProviderTool<PrefixName<Prefix, N>, I, P, C>
      : T extends SignalTool<infer N, infer I>
        ? SignalTool<PrefixName<Prefix, N>, I>
        : T extends InteractionTool<infer N, infer I>
          ? InteractionTool<PrefixName<Prefix, N>, I>
          : T

type Namespaced<Prefix extends string, T extends ToolMap> = {
  readonly [K in keyof T & string as PrefixName<Prefix, K>]: T[K] extends AnyTool
    ? PrefixTool<Prefix, T[K]>
    : never
}

/**
 * Prefix every tool name with `<namespace>__`, returning a new toolkit. Use it
 * to keep generic names (`search`) from two sources distinct before `compose`.
 * If two namespaces collide at the `__` separator, the duplicate final name
 * surfaces from `compose` as a `DuplicateToolName`.
 */
export const namespace = <const Prefix extends string, const T extends ToolMap>(
  prefix: Prefix,
  toolkit: Toolkit<T>,
): Toolkit<Namespaced<Prefix, T>> => {
  const renamed = Arr.map(Record.values(toolkit), (tool) => ({
    ...tool,
    name: `${prefix}__${tool.name}`,
  }))
  return indexByName(renamed) as Toolkit<Namespaced<Prefix, T>>
}

/** `namespace(prefix, make(...tools))` in one step, for static namespaced tools. */
export const makeNamespaced = <
  const Prefix extends string,
  const Tools extends ReadonlyArray<AnyTool>,
>(
  prefix: Prefix,
  ...tools: UniqueTools<Tools>
): Toolkit<Namespaced<Prefix, { [T in Tools[number] as T["name"]]: T }>> =>
  namespace(prefix, buildStatic(tools as unknown as Tools))

// --- composition (the application boundary) --------------------------------

/**
 * Combine independently-built toolkits into one. This is where names from
 * separate sources can collide, so it is the one effectful constructor: a
 * duplicate final name fails with `DuplicateToolName` (naming the colliding
 * input positions) instead of silently overwriting or 400-ing later at the
 * provider. Statically-known collisions are additionally a compile error.
 */
export const compose = <const Kits extends ReadonlyArray<Toolkit>>(
  ...toolkits: Kits & NoDuplicateComposedKeys<Kits>
): Effect.Effect<Toolkit<Composed<Kits>>, DuplicateToolName> =>
  Effect.gen(function* () {
    const kits = toolkits as unknown as ReadonlyArray<Toolkit>
    const labelled = Arr.flatMap(kits, (kit, i) =>
      Arr.map(Record.keys(kit), (name) => ({ name, source: `toolkit-${i}` })),
    )
    const collision = Arr.findFirst(
      Record.toEntries(Arr.groupBy(labelled, (entry) => entry.name)),
      ([, group]) => group.length > 1,
    )
    if (Option.isSome(collision)) {
      const [name, group] = collision.value
      return yield* new DuplicateToolName({ name, sources: Arr.map(group, (e) => e.source) })
    }
    return Arr.reduce(kits, {} as ToolMap, (acc, kit) => ({ ...acc, ...kit })) as Toolkit<
      Composed<Kits>
    >
  })

// ---------------------------------------------------------------------------
// Middleware: a `Toolkit -> Toolkit` transform applied up front, then the
// wrapped toolkit is run. A middleware transforms one local tool's `run` given
// its name (logging, retry, auth, metrics); `wrap` lifts it over the whole
// toolkit, leaving provider/signal/interaction kinds untouched. The one reason
// this is a combinator rather than native `Record.map`: it tracks the
// middleware's added requirement `R2`, unioning it into `ToolkitR` instead of
// widening every tool's type.
// ---------------------------------------------------------------------------

type Handler<Input, Event, Output, E, R> = (
  input: Input,
  emit: Emit<Event>,
) => Effect.Effect<Output, E, R>

/**
 * A `run` transform, tracking an added requirement `R2` and optional added
 * error `E2`. The tool's own `E` is preserved; `describeFailures` is the
 * combinator that *replaces* it (mapping every error to `string`).
 */
export type Middleware<R2 = never, E2 = never> = <Input, Event, Output, E, R>(
  run: Handler<Input, Event, Output, E, R>,
  name: string,
) => Handler<Input, Event, Output, E | E2, R | R2>

type WrapTool<T extends AnyTool, R2, E2> =
  T extends Tool<infer N, infer I, infer Ev, infer O, infer E, infer R>
    ? Tool<N, I, Ev, O, E | E2, R | R2>
    : T

type WrapToolkit<T extends ToolMap, R2, E2> = {
  readonly [K in keyof T]: T[K] extends AnyTool ? WrapTool<T[K], R2, E2> : T[K]
}

/**
 * Wrap every local tool's `run` with a middleware, preserving each tool's
 * `Input`/`Output` and unioning the middleware's requirement `R2` into the
 * toolkit's `ToolkitR`. Non-local kinds pass through unchanged. Stack with
 * `pipe` - inner-first, so the last `wrap` applied is the outermost and runs
 * first:
 *
 *   const observed = pipe(toolkit, Toolkit.wrap(logging), Toolkit.wrap(authz))
 *   Toolkit.run(observed, calls) // authz runs, then logging, then the tool
 *
 * A middleware that fails with `string` / `ToolFailed` is absorbed by the
 * executor into a `ToolResult.Failure`; any other error propagates typed. Use
 * `describeFailures` for the total "everything to the model" case, or the
 * `Approval` flow for a distinct "denied" verdict.
 */
export const wrap: {
  <R2, E2>(
    middleware: Middleware<R2, E2>,
  ): <T extends Toolkit>(toolkit: T) => WrapToolkit<T, R2, E2>
  <T extends Toolkit, R2, E2>(toolkit: T, middleware: Middleware<R2, E2>): WrapToolkit<T, R2, E2>
} = Function.dual(
  2,
  <T extends Toolkit, R2, E2>(toolkit: T, middleware: Middleware<R2, E2>): WrapToolkit<T, R2, E2> =>
    Record.map(toolkit, (tool) =>
      tool._tag === "LocalTool" ? { ...tool, run: middleware(tool.run, tool.name) } : tool,
    ) as WrapToolkit<T, R2, E2>,
)

// ---------------------------------------------------------------------------
// describeFailures: map every local tool's error to a model-visible string,
// opting its failures into recovery. Group tools by recovery policy, wrap
// each group, then compose.
// ---------------------------------------------------------------------------

type DescribeTool<T extends AnyTool> =
  T extends Tool<infer N, infer I, infer Ev, infer O, any, infer R>
    ? Tool<N, I, Ev, O, string, R>
    : T

type DescribeToolkit<T extends ToolMap> = {
  readonly [K in keyof T]: T[K] extends AnyTool ? DescribeTool<T[K]> : T[K]
}

/**
 * Map every local tool's error to a `string`, so `Toolkit.run` absorbs those
 * failures into `ToolResult.Failure` the model reads and adapts to. Pairs
 * with the domain `describe` helpers (`AiError.describe`,
 * `BrowserError.describe`). Non-local kinds pass through.
 *
 *   const kit = yield* Toolkit.compose(
 *     Toolkit.describeFailures(searchKit, AiError.describe),
 *     browserToolkit(session), // failures stay typed
 *   )
 */
export const describeFailures: {
  <E>(describe: (e: E) => string): <T extends Toolkit>(toolkit: T) => DescribeToolkit<T>
  <T extends Toolkit>(toolkit: T, describe: (e: ToolkitE<T>) => string): DescribeToolkit<T>
} = Function.dual(
  2,
  <T extends Toolkit>(toolkit: T, describe: (e: any) => string): DescribeToolkit<T> =>
    Record.map(toolkit, (tool) =>
      tool._tag === "LocalTool"
        ? {
            ...tool,
            run: (input: unknown, emit: Emit<unknown>) =>
              (tool as AnyLocalTool).run(input, emit).pipe(Effect.mapError(describe)),
          }
        : tool,
    ) as DescribeToolkit<T>,
)

// ---------------------------------------------------------------------------
// Tool executor. Streams `ToolEvent`s in real time. Policy stays outside this
// module: callers pass only the calls they have already decided should run.
// ---------------------------------------------------------------------------

export type ExecuteOptions = {
  readonly concurrency?: number | "unbounded"
}

/**
 * Execute every provided call. Approval/rejection policy belongs upstream.
 *
 * String and `ToolFailed` failures are absorbed into `ToolResult.Failure`
 * (the model reads and adapts to them); every other tool error propagates
 * typed on the stream, so `Exclude<ToolkitE<T>, string | ToolFailed>` is
 * what a caller catches or lets end the run. If one call in a concurrent
 * batch fails the stream, siblings may go unanswered: a loop that catches
 * and continues must reconcile history first (`HistoryCheck.cancelAllPending`).
 */
export const run = <T extends Toolkit>(
  toolkit: T,
  calls: ReadonlyArray<ToolCall>,
  options?: ExecuteOptions,
): Stream.Stream<ToolEvent, Exclude<ToolkitE<T>, string | ToolFailed>, ToolkitR<T>> =>
  Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) => runOne(toolkit, call), {
      concurrency: options?.concurrency ?? "unbounded",
    }),
  ) as Stream.Stream<ToolEvent, Exclude<ToolkitE<T>, string | ToolFailed>, ToolkitR<T>>

const okResult = (call: ToolCall, tool: string, value: unknown): ToolResult =>
  ToolResult.Ok({ call_id: call.call_id, tool, value })

const outputEvent = (result: ToolResult): Stream.Stream<ToolEvent, never, any> =>
  Stream.succeed(ToolEvent.Output({ result }))

const runOne = (toolkit: ToolMap, call: ToolCall): Stream.Stream<ToolEvent, unknown, any> => {
  // Own-property lookup: a hallucinated call named `constructor` / `toString`
  // must not resolve to a prototype method.
  const tool = Object.hasOwn(toolkit, call.name) ? toolkit[call.name] : undefined
  return Match.value(tool).pipe(
    // No such tool. Graceful: emit a synthetic Failure so OTHER calls in this
    // turn still execute. LLMs hallucinate tool names; MCP tools come and go.
    Match.when(Match.undefined, () =>
      outputEvent(failed(call, "unknown_tool", `No tool registered with name "${call.name}"`)),
    ),
    Match.tag("LocalTool", (local) => runTool(local, call)),
    // Provider/signal/interaction tools are model-visible but not locally
    // executable. The loop is expected to intercept these (decode + act) before
    // execution; reaching here means it didn't, so report it rather than crash.
    Match.orElse(() => outputEvent(nonLocalTool(call))),
  )
}

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

// A decode failure is the model's contract violation: report it as a result
// (never a stream failure) so the model can correct its next call.
const runTool = (tool: AnyLocalTool, call: ToolCall): Stream.Stream<ToolEvent, unknown, any> =>
  Stream.unwrap(
    decodeCallInput(tool, call).pipe(
      Effect.map(
        Match.type<DecodeResult<unknown>>().pipe(
          Match.tag("parseError", () =>
            outputEvent(validationError(call, "arguments are not valid JSON")),
          ),
          Match.tag("invalid", ({ issues }) =>
            outputEvent(validationError(call, describeIssues(issues))),
          ),
          Match.tag("ok", ({ input }) => runValidated(tool, call, input)),
          Match.exhaustive,
        ),
      ),
    ),
  )

const runValidated = (
  tool: AnyLocalTool,
  call: ToolCall,
  input: unknown,
): Stream.Stream<ToolEvent, unknown, any> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Per-call queue: `emit` offers events as `run` produces them; the
      // progress stream drains them in real time; `Queue.end` (in the
      // `ensuring`) flushes pending events then signals a clean end, which
      // `Stream.fromQueue` treats as completion. `Queue.shutdown` would clear
      // queued items and interrupt pending takes — wrong for graceful teardown.
      const queue = yield* Queue.make<unknown, Cause.Done>({ capacity: tool.emitBufferSize })
      const emit = (event: unknown) => Effect.asVoid(Queue.offer(queue, event))
      const fiber = yield* tool
        .run(input, emit)
        .pipe(Effect.ensuring(Queue.end(queue)), Effect.forkScoped)

      const progress = Stream.fromQueue(queue).pipe(
        Stream.map((data) => ToolEvent.Progress({ call_id: call.call_id, tool: tool.name, data })),
      )
      const output = Stream.fromEffect(
        Fiber.join(fiber).pipe(
          Effect.matchCauseEffect({
            onSuccess: (value: unknown) =>
              Effect.succeed(ToolEvent.Output({ result: okResult(call, tool.name, value) })),
            onFailure: (cause: Cause.Cause<unknown>) => routeCause(call, cause),
          }),
        ),
      )
      return progress.pipe(Stream.concat(output))
    }),
  )

// A clean single string / ToolFailed failure is absorbed as a model-visible
// result; interruption, defects, and typed non-sentinel errors propagate.
const routeCause = (
  call: ToolCall,
  cause: Cause.Cause<unknown>,
): Effect.Effect<ToolEvent, unknown> => {
  const only = cause.reasons.length === 1 ? cause.reasons[0] : undefined
  if (only !== undefined && Cause.isFailReason(only)) {
    const error = only.error
    if (typeof error === "string") {
      return Effect.succeed(ToolEvent.Output({ result: failed(call, "tool_failed", error) }))
    }
    if (error instanceof ToolFailed) {
      return Effect.succeed(
        ToolEvent.Output({ result: failed(call, error.kind ?? "tool_failed", error.message) }),
      )
    }
  }
  return Effect.failCause(cause)
}

// ---------------------------------------------------------------------------
// `continueWithResults` - bridge from a `Stream<ToolEvent>` to the loop's
// emit shape. Drains the stream to the consumer in real-time, taps every
// `Output` into an internal Ref, and at end-of-stream emits
// `Loop.next(build(results))`. Recipe never sees the Ref.
//
// Dual: data-first `continueWithResults(stream, build)` and data-last
// `stream.pipe(continueWithResults(build))` both work.
// ---------------------------------------------------------------------------

/**
 * Append a completed turn plus tool results to a state's history, converting
 * the results to wire-format `ToolCallOutput`s. Curried so it slots directly
 * into `continueWithResults`:
 *
 *   Toolkit.run(toolkit, calls).pipe(
 *     Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)),
 *   )
 *
 * Equivalent to `appendToHistory(state, turn, results.map(toToolCallOutput))`
 * — the helper just hides the wire-conversion step.
 */
export const appendToolResults =
  <S extends { readonly history: ReadonlyArray<HistoryItem> }>(state: S, turn: Turn) =>
  (results: ReadonlyArray<ToolResult>): S =>
    appendToHistory(state, turn, results.map(toToolCallOutput))

/**
 * Drain a `Stream<ToolEvent>` and return the accumulated `ToolResult`s
 * from every `Output` event. One-shot — the type is `Effect<results>`,
 * not a one-element stream — so it composes naturally with `Effect.map`
 * to build state.
 *
 * Counterpart to `continueWithResults`: `continueWithResults` bundles
 * drain + emit Next into one bridge; this one is the right arm of a
 * broadcast/fork-and-merge for callers that want to vary the left arm
 * (e.g., filter/tap ToolEvents before forwarding).
 */
export const collectResults = <E, R>(
  stream: Stream.Stream<ToolEvent, E, R>,
): Effect.Effect<ReadonlyArray<ToolResult>, E, R> =>
  stream.pipe(
    Stream.filter(isOutput),
    Stream.map((e) => e.result),
    Stream.runCollect,
  )

/**
 * Bridge from a `Stream<ToolEvent>` to the loop's emit shape. Forwards
 * every ToolEvent downstream as a `Loop.value` and at end-of-stream emits
 * one `Loop.next(build(results))` carrying the accumulated `ToolResult`s
 * from terminal `Output` events.
 *
 * Conceptually a broadcast fork (one arm passes events through, the other
 * drains them into a state). Implemented as a single-pass Ref tap + concat
 * for zero buffering — the broadcast version is observationally equivalent
 * but holds events in a PubSub until both arms drain. The public primitives
 * (`Loop.value`, `collectResults`, `Loop.next`) compose the same pattern
 * when you need to vary an arm.
 *
 * Dual: data-first `continueWithResults(stream, build)` and data-last
 * `stream.pipe(continueWithResults(build))` both work.
 */
export const continueWithResults: {
  <S>(
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): <E, R>(stream: Stream.Stream<ToolEvent, E, R>) => Stream.Stream<Loop.Step<ToolEvent, S>, E, R>
  <S, E, R>(
    stream: Stream.Stream<ToolEvent, E, R>,
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): Stream.Stream<Loop.Step<ToolEvent, S>, E, R>
} = Function.dual(
  2,
  <S, E, R>(
    stream: Stream.Stream<ToolEvent, E, R>,
    build: (results: ReadonlyArray<ToolResult>) => S,
  ): Stream.Stream<Loop.Step<ToolEvent, S>, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<ToolResult>>([])
        const tapped = stream.pipe(
          Stream.tap((e) =>
            isOutput(e) ? Ref.update(ref, (acc) => Arr.append(acc, e.result)) : Effect.void,
          ),
          Stream.map(Loop.value),
        )
        const continuation = Stream.unwrap(
          Ref.get(ref).pipe(Effect.map((acc) => Loop.next(build(acc)))),
        )
        return tapped.pipe(Stream.concat(continuation))
      }),
    ),
)
