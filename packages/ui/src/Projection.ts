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
import type * as Realtime from "@effect-uai/core/Realtime"
import type * as ToolEvent from "@effect-uai/core/ToolEvent"
import type * as Transcript from "@effect-uai/core/Transcript"
import * as Turn from "@effect-uai/core/Turn"
import { Array as A, Duration, Effect, Match, Option, Record, Schema, Stream } from "effect"
import * as Frame from "./Frame.js"
import type { Owned } from "./Run.js"
import { type Json, PROTOCOL_VERSION, RunId, type RunEvent } from "./RunEvent.js"
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

// ---------------------------------------------------------------------------
// Speech: transcripts and realtime sessions
// ---------------------------------------------------------------------------

/** One utterance as `fromTranscript` sends it; type a contract's entry with it. */
export const Utterance = Schema.Struct({
  text: Schema.String,
  final: Schema.Boolean,
  words: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        startSeconds: Schema.Number,
        endSeconds: Schema.Number,
      }),
    ),
  ),
})
export type Utterance = typeof Utterance.Type

const utterance = (
  name: string,
  id: number,
  text: string,
  final: boolean,
  words: ReadonlyArray<Transcript.WordTimestamp> | undefined,
): RunEvent => ({
  type: "data",
  name,
  id: String(id),
  value: {
    text,
    final,
    ...(words !== undefined && {
      words: words.map((w) => ({
        text: w.text,
        startSeconds: w.startSeconds,
        endSeconds: w.endSeconds,
      })),
    }),
  },
})

/**
 * Transcript fold: the next utterance id. Partials overwrite their utterance's
 * entry, its final settles it, and the next partial starts a new id. Other
 * events produce nothing; map them yourself and delegate the rest here.
 */
export const transcriptStep =
  (name = "transcript") =>
  (n: number, event: Transcript.TranscriptEvent): readonly [number, ReadonlyArray<RunEvent>] =>
    Match.value(event).pipe(
      Match.tag("partial", (e) => [n, [utterance(name, n, e.text, false, e.words)]] as const),
      Match.tag("final", (e) => [n + 1, [utterance(name, n, e.text, true, e.words)]] as const),
      Match.orElse(() => [n, []] as const),
    )

/**
 * Stream operator: a live transcript as stream-scoped `data` entries named
 * `name` (default `"transcript"`), one per utterance, valued as `Utterance`.
 * Expects snapshots: pipe delta providers through `Transcript.accumulatePartials`.
 */
export const fromTranscript =
  (options?: { readonly name?: string }) =>
  <E, R>(self: Stream.Stream<Transcript.TranscriptEvent, E, R>): Stream.Stream<RunEvent, E, R> =>
    self.pipe(Stream.mapAccum(() => 0, transcriptStep(options?.name)))

export type RealtimeOptions = {
  /** The channel each response's audio goes down on; it opens with the run and closes with it. */
  readonly channel: number
  readonly format: { readonly sampleRate: number; readonly channels?: number }
  /** `run-started.name` of every response. Default `"assistant"`. */
  readonly name?: string
  /** `data` name of the user's transcript. Default `"transcript"`. */
  readonly transcript?: string
}

export const RealtimeState = Schema.Struct({
  /** Responses whose run is open. */
  open: Schema.Array(Schema.String),
  /** Calls not yet answered, with the run that made them. */
  calls: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, runId: RunId })),
  utterance: Schema.Number,
  /** The current utterance so far: its partials are deltas. */
  heard: Schema.String,
})
export type RealtimeState = typeof RealtimeState.Type

export const realtimeInitial: RealtimeState = { open: [], calls: {}, utterance: 0, heard: "" }

type Live = readonly [RealtimeState, ReadonlyArray<Frame.Frame<Owned>>]

const owned = (event: RunEvent, runId?: string): Frame.Frame<Owned> =>
  Frame.message(runId === undefined ? { event } : { runId: RunId.make(runId), event })

const terminalOf = (reason: "complete" | "interrupted" | "cancelled" | "error"): RunEvent =>
  Match.value(reason).pipe(
    Match.when("complete", (): RunEvent => ({ type: "run-completed" })),
    Match.when("error", (): RunEvent => ({ type: "run-failed", reason: "error" })),
    Match.orElse((r): RunEvent => ({ type: "run-stopped", reason: r })),
  )

/**
 * Realtime fold. Each response is a run (its id is the `responseId`) that
 * opens its own audio channel; an interruption ends it with
 * `run-stopped { reason: "barge-in" }`, which closes the channel, so the
 * client drops what it still has queued. Audio of a response already ended
 * is dropped. Running tools stays the app's: answer a `tool-call-ready` with
 * a `tool-result` in the call's run (the `ToolCall`'s `responseId`).
 */
export const realtimeStep =
  (options: RealtimeOptions) =>
  (s: RealtimeState, event: Realtime.RealtimeEvent): Live => {
    const isOpen = (id: string) => s.open.includes(id)
    const close = (id: string): RealtimeState => ({ ...s, open: s.open.filter((o) => o !== id) })
    return Match.value(event).pipe(
      Match.tagsExhaustive({
        ResponseStarted: ({ responseId }): Live =>
          isOpen(responseId)
            ? [s, []]
            : [
                { ...s, open: [...s.open, responseId] },
                [
                  owned(
                    {
                      type: "run-started",
                      runId: RunId.make(responseId),
                      name: options.name ?? "assistant",
                      inputs: [],
                      protocol: PROTOCOL_VERSION,
                    },
                    responseId,
                  ),
                  owned(
                    {
                      type: "channel-opened",
                      channel: options.channel,
                      direction: "down",
                      mimeType: "audio/pcm",
                      sampleRate: options.format.sampleRate,
                      channels: options.format.channels ?? 1,
                    },
                    responseId,
                  ),
                ],
              ],
        AudioDelta: ({ responseId, bytes }): Live =>
          isOpen(responseId) ? [s, [Frame.media(options.channel, bytes)]] : [s, []],
        OutputTranscriptDelta: ({ responseId, text }): Live =>
          isOpen(responseId) ? [s, [owned({ type: "text-delta", text }, responseId)]] : [s, []],
        ToolCall: ({ responseId, call }): Live => [
          {
            ...s,
            calls: {
              ...s.calls,
              [call.call_id]: { name: call.name, runId: RunId.make(responseId) },
            },
          },
          [
            owned(
              {
                type: "tool-call-ready",
                callId: call.call_id,
                name: call.name,
                input: decodeJson(call.arguments),
              },
              responseId,
            ),
          ],
        ],
        ToolCallCancelled: ({ callIds }): Live => [
          { ...s, calls: Record.filter(s.calls, (_, id) => !callIds.includes(id)) },
          A.getSomes(
            callIds.map((callId) =>
              Option.map(Record.get(s.calls, callId), (call) =>
                owned(
                  {
                    type: "tool-result",
                    callId,
                    name: call.name,
                    result: { _tag: "Failure", error: "cancelled" },
                  },
                  call.runId,
                ),
              ),
            ),
          ),
        ],
        Interrupted: ({ responseId }): Live =>
          isOpen(responseId)
            ? [close(responseId), [owned({ type: "run-stopped", reason: "barge-in" }, responseId)]]
            : [s, []],
        ResponseDone: ({ responseId, reason, usage }): Live =>
          isOpen(responseId)
            ? [
                close(responseId),
                [
                  ...(usage === undefined ? [] : [owned({ type: "usage", usage }, responseId)]),
                  owned(terminalOf(reason), responseId),
                ],
              ]
            : [s, []],
        // Partials extend the utterance; its final is the whole text and replaces them.
        InputTranscript: ({ text, final }): Live => [
          final ? { ...s, utterance: s.utterance + 1, heard: "" } : { ...s, heard: s.heard + text },
          [
            owned(
              utterance(
                options.transcript ?? "transcript",
                s.utterance,
                final ? text : (s.heard + text).trim(),
                final,
                undefined,
              ),
            ),
          ],
        ],
        SpeechStarted: (): Live => [s, [owned({ type: "live", name: "vad", value: true })]],
        SpeechStopped: (): Live => [s, [owned({ type: "live", name: "vad", value: false })]],
        SessionEnding: ({ timeLeft }): Live => [
          s,
          [
            owned({
              type: "live",
              name: "session-ending",
              value: timeLeft === undefined ? null : Duration.toMillis(timeLeft),
            }),
          ],
        ],
        Error: ({ code, message }): Live => [
          s,
          [
            owned({
              type: "live",
              name: "error",
              value: code === undefined ? { message } : { code, message },
            }),
          ],
        ],
        // A provider resumption handle is the server's to keep.
        ResumptionHandle: (): Live => [s, []],
      }),
    )
  }

/**
 * Stream operator: a realtime session's events as frames: runs, entries and
 * `live` values to sequence (`Frame.sequence`), and each response's audio as
 * media on `options.channel`.
 */
export const fromRealtime =
  (options: RealtimeOptions) =>
  <E, R>(
    self: Stream.Stream<Realtime.RealtimeEvent, E, R>,
  ): Stream.Stream<Frame.Frame<Owned>, E, R> =>
    self.pipe(Stream.mapAccum(() => realtimeInitial, realtimeStep(options)))
