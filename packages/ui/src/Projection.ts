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
import { ToolResult } from "@effect-uai/core/ToolResult"
import * as Turn from "@effect-uai/core/Turn"
import { Match, Option, Schema, Stream } from "effect"
import type { RunEvent } from "./RunEvent.js"

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

export const State = Schema.Struct({ inStep: Schema.Boolean, reasoningShown: Schema.Boolean })
export type State = typeof State.Type

export const initial: State = { inStep: false, reasoningShown: false }

type Step = readonly [State, ReadonlyArray<RunEvent>]

// Tool arguments and outputs cross effect-uai as JSON strings; hand the client
// the decoded value, falling back to the raw string when it isn't JSON.
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeJson = (raw: string): unknown => Option.getOrElse(parseJson(raw), () => raw)

// Content belongs to a step (one model turn); open one lazily on its first event.
const inStep = (s: State, events: ReadonlyArray<RunEvent>): Step =>
  s.inStep
    ? [s, events]
    : [{ inStep: true, reasoningShown: false }, [{ type: "step-started" }, ...events]]

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
  const ready = Turn.getToolCalls(turn).map((call): RunEvent => ({
    type: "tool-call-ready",
    callId: call.call_id,
    name: call.name,
    input: decodeJson(call.arguments),
  }))
  const [, events] = inStep(s, [...ready, { type: "step-finished", usage: turn.usage }])
  return [initial, events]
}

const toolResult = (result: ToolResult): RunEvent =>
  ToolResult.$match(result, {
    Ok: (ok): RunEvent => ({
      type: "tool-result",
      callId: ok.call_id,
      output: ok.value,
      isError: false,
    }),
    Failure: (f): RunEvent => ({
      type: "tool-result",
      callId: f.call_id,
      output: f.reason === undefined ? { kind: f.kind } : { kind: f.kind, reason: f.reason },
      isError: true,
    }),
  })

/** Map one loop event onto zero or more `RunEvent`s. */
export const step =
  (options?: Options) =>
  (s: State, event: Source): Step =>
    Match.value(event).pipe(
      Match.when({ type: "function_call_output" }, (o): Step => [
        s,
        [{ type: "tool-result", callId: o.call_id, output: decodeJson(o.output), isError: false }],
      ]),
      Match.tags({
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
        ApprovalRequested: (e): Step => [
          s,
          [
            {
              type: "tool-approval-requested",
              callId: e.call_id,
              name: e.tool,
              input: decodeJson(e.arguments),
            },
          ],
        ],
        Progress: (e): Step => [s, [{ type: "tool-progress", callId: e.call_id, data: e.data }]],
        Output: (e): Step => [s, [toolResult(e.result)]],
      }),
      Match.exhaustive,
    )

/** Stream operator: project a loop's events onto `RunEvent`s. */
export const toRunEvents =
  (options?: Options) =>
  <E, R>(self: Stream.Stream<Source, E, R>): Stream.Stream<RunEvent, E, R> =>
    self.pipe(Stream.mapAccum(() => initial, step(options)))
