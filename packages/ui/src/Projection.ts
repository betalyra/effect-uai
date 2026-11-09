/**
 * Project an effect-uai loop onto `RunEvent`s. The projection is a fold pair
 * (`initial`, `step`) because step boundaries need state; `toRunEvents` runs
 * it over a stream. To add app events (metrics, domain data), map them
 * yourself and delegate the rest to `step`.
 *
 * Never forwards `TurnComplete.turn` itself: it carries `providerData`
 * (encrypted reasoning, item ids) that must not reach a browser.
 */
import type * as Items from "@effect-uai/core/Items"
import type * as ToolEvent from "@effect-uai/core/ToolEvent"
import * as Turn from "@effect-uai/core/Turn"
import { Effect, Match, Option, Schema, Stream } from "effect"
import type { Json, RunEvent } from "./RunEvent.js"
import * as UiContract from "./UiContract.js"

/** What an effect-uai loop emits: turn events, tool events, and plain tool outputs. */
export type Source = Turn.TurnEvent | ToolEvent.ToolEvent | Items.ToolCallOutput

export const Options = Schema.Struct({
  /**
   * `"signal"` (default): only `reasoning-started`. `"summary"`: also
   * forward summary deltas. `"full"`: also forward raw reasoning traces.
   */
  reasoning: Schema.optionalKey(Schema.Literals(["signal", "summary", "full"])),
  /** Forward raw tool-argument deltas (`tool-call-args-delta`). Default false. */
  toolArgs: Schema.optionalKey(Schema.Boolean),
})
export type Options = typeof Options.Type

/** `Options` plus the contract whose tool schemas encode tool values and errors. */
export type Config = Options & {
  readonly contract: Pick<UiContract.UiContract<any>, "toolEvent" | "toolOutput">
}

export const State = Schema.Struct({
  inStep: Schema.Boolean,
  reasoningShown: Schema.Boolean,
  /** Tool names by call id, for outputs that arrive as plain `function_call_output` items. */
  tools: Schema.Record(Schema.String, Schema.String),
})
export type State = typeof State.Type

export const initial: State = { inStep: false, reasoningShown: false, tools: {} }

type Step = readonly [State, ReadonlyArray<RunEvent>]

// Tool arguments are a JSON string; hand the client the decoded value, falling
// back to the raw string when it isn't JSON.
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))
const decodeJson = (raw: string): Json => Option.getOrElse(parseJson(raw), () => raw)

// Content belongs to a step (one model turn); open one lazily on its first event.
const inStep = (s: State, events: ReadonlyArray<RunEvent>): Step =>
  s.inStep
    ? [s, events]
    : [{ ...s, inStep: true, reasoningShown: false }, [{ type: "step-started" }, ...events]]

const reasoning =
  (options: Options | undefined) =>
  (s: State, e: Extract<Turn.TurnEvent, { _tag: "ReasoningDelta" }>): Step => {
    const mode = options?.reasoning ?? "signal"
    const forward = mode === "full" || (mode === "summary" && e.kind === "summary")
    const [opened, prefix] = inStep(s, [])
    const started: ReadonlyArray<RunEvent> = opened.reasoningShown
      ? []
      : [{ type: "reasoning-started" }]
    const delta: ReadonlyArray<RunEvent> = forward
      ? [{ type: "reasoning-delta", text: e.text, kind: e.kind }]
      : []
    return [{ ...opened, reasoningShown: true }, [...prefix, ...started, ...delta]]
  }

const turnComplete = (s: State, turn: Turn.Turn): Step => {
  const calls = Turn.getToolCalls(turn)
  const ready = calls.map((call): RunEvent => ({
    type: "tool-call-ready",
    callId: call.call_id,
    name: call.name,
    input: decodeJson(call.arguments),
  }))
  const [, events] = inStep(s, [...ready, { type: "step-finished", usage: turn.usage }])
  const tools = { ...s.tools, ...Object.fromEntries(calls.map((c) => [c.call_id, c.name])) }
  return [{ ...initial, tools }, events]
}

// A history item already holds the encoded value; the contract shapes it for the wire.
const outputResult = (config: Config, s: State, o: Items.ToolCallOutput) =>
  Effect.map(config.contract.toolOutput(o, s.tools[o.call_id] ?? ""), (event): Step => [s, [event]])

/** Map one loop event onto zero or more `RunEvent`s; tool values are encoded by the contract. */
export const step =
  (config: Config) =>
  (s: State, event: Source): Effect.Effect<Step, Schema.SchemaError> =>
    Match.value(event).pipe(
      Match.when({ type: "function_call_output" }, (o) => outputResult(config, s, o)),
      Match.tags({
        Partial: (e) => Effect.map(config.contract.toolEvent(e), (r): Step => [s, [r]]),
        Output: (e) => Effect.map(config.contract.toolEvent(e), (r): Step => [s, [r]]),
      }),
      Match.orElse((e) => Effect.succeed(turnStep(config)(s, e))),
    )

const turnStep =
  (options: Options) =>
  (s: State, event: Turn.TurnEvent): Step =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        TextDelta: (e) => inStep(s, [{ type: "text-delta", text: e.text }]),
        RefusalDelta: (e) => inStep(s, [{ type: "refusal-delta", text: e.text }]),
        ReasoningDelta: (e) => reasoning(options)(s, e),
        ToolCallStart: (e) =>
          inStep(s, [{ type: "tool-call-started", callId: e.call_id, name: e.name }]),
        ToolCallArgsDelta: (e) =>
          inStep(
            s,
            options?.toolArgs === true
              ? [{ type: "tool-call-args-delta", callId: e.call_id, delta: e.delta }]
              : [],
          ),
        CitationAdded: (e) => inStep(s, [{ type: "citation", annotation: e.annotation }]),
        ImageOutput: (e) =>
          inStep(s, [
            e.partialIndex === undefined
              ? { type: "image", image: e.image }
              : { type: "image", image: e.image, partialIndex: e.partialIndex },
          ]),
        // Usage arrives on `step-finished`; search progress has no UI event yet.
        UsageUpdate: (): Step => [s, []],
        WebSearchCall: (): Step => [s, []],
        TurnComplete: (e) => turnComplete(s, e.turn),
      }),
    )

/**
 * Stream operator: project a loop's events onto `RunEvent`s. A tool value the
 * contract can't encode fails the stream: a contract violation, not data to show.
 */
export const toRunEvents =
  (config: Config) =>
  <E, R>(self: Stream.Stream<Source, E, R>): Stream.Stream<RunEvent, E | Schema.SchemaError, R> =>
    self.pipe(Stream.mapAccumEffect(() => initial, step(config)))
