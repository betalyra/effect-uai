import { describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { expect } from "vitest"
import { RealtimeEvent, type RealtimeInput } from "@effect-uai/core/Realtime"
import * as MockRealtimeSession from "@effect-uai/core/testing/MockRealtimeSession"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Frame from "@effect-uai/ui/Frame"
import { RunId, StreamId } from "@effect-uai/ui/RunEvent"
import * as StreamView from "@effect-uai/ui/StreamView"
import { MIC, SPEAKER, type Up } from "./contract.js"
import { type AgentConfig, runAgent } from "./recipe.js"

const pcm = { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } as const

const cfg: AgentConfig = {
  model: "gpt-realtime-2.1",
  instructions: "be terse",
  voiceId: "marin",
  inputFormat: pcm,
  outputFormat: pcm,
}

/** Slow enough that a cancellation lands while it is still running. */
const getTime = Tool.make({
  name: "get_current_time",
  description: "The current time.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ timezone: Schema.String })),
  outputSchema: Schema.Struct({ timezone: Schema.String, iso: Schema.String }),
  run: ({ timezone }) =>
    Effect.succeed({ timezone, iso: "2026-09-12T12:00:00Z" }).pipe(Effect.delay("30 millis")),
})

const toolkit = Toolkit.make(getTime)

const toolCall = {
  type: "function_call",
  call_id: "call_1",
  name: "get_current_time",
  arguments: '{"timezone":"Europe/Lisbon"}',
  providerData: undefined,
} as const

const r1 = RunId.make("r1")

/**
 * Run the agent against a scripted session until it goes quiet, then fold
 * what it sent the browser into a `StreamView`, the way the page does, and
 * report everything it pushed back at the model.
 */
const run = (
  initial: ReadonlyArray<RealtimeEvent>,
  /** Positions the browser would report after cutting playback. */
  played: ReadonlyArray<number> = [],
) =>
  Effect.gen(function* () {
    const mock = MockRealtimeSession.layer({ initial })
    // A real browser reports positions once it has heard some audio, so let
    // the scripted events land first.
    const up: Stream.Stream<Frame.Frame<Up>> = Stream.make(
      Frame.media(MIC, new Uint8Array([1, 2])),
    ).pipe(
      Stream.concat(
        Stream.fromIterable(played).pipe(
          Stream.mapEffect((playedMs) =>
            Effect.as(
              Effect.sleep("40 millis"),
              Frame.message<Up>({ kind: "playback", channel: SPEAKER, playedMs }),
            ),
          ),
        ),
      ),
    )

    // The session stays open until its scope closes, so bound the run instead
    // of waiting for an end that never comes.
    const frames = yield* runAgent(cfg, toolkit, up).pipe(
      Stream.interruptWhen(Effect.sleep("250 millis")),
      Stream.runCollect,
      Effect.provide(mock.layer),
    )

    const view = yield* Stream.fromIterable(frames).pipe(
      Frame.sequence(StreamId.make("agent")),
      Stream.runFold(
        () => StreamView.initial,
        (v, frame) => (frame._tag === "Message" ? StreamView.step(v, frame.message) : v),
      ),
    )
    const tool = view.runs[r1]?.blocks.find((b) => b.type === "tool")
    return { view, tool, sent: (yield* mock.recorder).sent }
  })

const sentOf = <T extends RealtimeInput["_tag"]>(
  sent: ReadonlyArray<RealtimeInput>,
  tag: T,
): ReadonlyArray<Extract<RealtimeInput, { readonly _tag: T }>> =>
  sent.filter((i): i is Extract<RealtimeInput, { readonly _tag: T }> => i._tag === tag)

describe("realtime voice agent", () => {
  it.live("runs a tool the model asks for and hands the serialized result back", () =>
    Effect.gen(function* () {
      const { view, tool, sent } = yield* run([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.ToolCall({ responseId: "r1", call: toolCall }),
      ])

      // The microphone reaches the model without waiting for anything.
      expect(sentOf(sent, "Audio")).toHaveLength(1)
      // The page is told the rate to record at.
      expect(view.channels[String(MIC)]?.sampleRate).toBe(24000)

      const [result] = sentOf(sent, "ToolResult")
      expect(result?.output.call_id).toBe("call_1")
      expect(result?.output.output).toMatchObject([{ type: "input_json" }])
      expect(JSON.stringify(result?.output.output)).toContain("2026-09-12")
      expect(tool).toMatchObject({
        status: "done",
        input: { timezone: "Europe/Lisbon" },
        outcome: { _tag: "Success", value: { iso: "2026-09-12T12:00:00Z" } },
      })
    }),
  )

  it.live("interrupts a tool the model abandoned, so its answer never arrives", () =>
    Effect.gen(function* () {
      const { tool, sent } = yield* run([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.ToolCall({ responseId: "r1", call: toolCall }),
        // Lands while the 30 ms tool is still running. Without the interrupt
        // the result would be sent a moment later, well inside the run window.
        RealtimeEvent.ToolCallCancelled({ callIds: ["call_1"] }),
      ])

      expect(sentOf(sent, "ToolResult")).toHaveLength(0)
      expect(tool).toMatchObject({ status: "failed", outcome: { error: "cancelled" } })
    }),
  )

  it.live("still interrupts a call the model abandons after its response ended", () =>
    Effect.gen(function* () {
      const { view, tool, sent } = yield* run([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.ToolCall({ responseId: "r1", call: toolCall }),
        // The response carrying the call ends while the tool is still running,
        // which is the ordinary case, not an edge one.
        RealtimeEvent.ResponseDone({ responseId: "r1", reason: "complete" }),
        RealtimeEvent.ToolCallCancelled({ callIds: ["call_1"] }),
      ])

      expect(sentOf(sent, "ToolResult")).toHaveLength(0)
      expect(view.runs[r1]?.status).toBe("completed")
      expect(tool).toMatchObject({ status: "failed", outcome: { error: "cancelled" } })
    }),
  )

  it.live("stops the voice on the interruption, not on the first words heard", () =>
    Effect.gen(function* () {
      const { view } = yield* run([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        // Recognised words alone say nothing about whether the answer that
        // just started is still wanted: they are unordered against it.
        RealtimeEvent.InputTranscript({ text: "actually", final: false }),
        RealtimeEvent.InputTranscript({ text: "actually wait", final: true }),
        RealtimeEvent.AudioDelta({ responseId: "r1", bytes: new Uint8Array([1, 2]) }),
        RealtimeEvent.Interrupted({ responseId: "r1" }),
      ])

      expect(view.data["transcript"]).toEqual({ "0": { text: "actually wait", final: true } })
      expect(view.runs[r1]?.status).toBe("stopped")
      // Its audio channel closed with it, which is what tells the page to drop the rest.
      expect(view.channels[String(SPEAKER)]).toBeUndefined()
    }),
  )

  it.live("labels a reported position with the answer that was playing", () =>
    Effect.gen(function* () {
      const { sent } = yield* run(
        [
          RealtimeEvent.ResponseStarted({ responseId: "r1" }),
          RealtimeEvent.AudioDelta({ responseId: "r1", bytes: new Uint8Array(24000) }),
          // The server considers this answer finished while the speakers are
          // still working through it.
          RealtimeEvent.ResponseDone({ responseId: "r1", reason: "complete" }),
        ],
        [820],
      )

      // The position belongs to r1 even though its response is over, which is
      // the case a server-side byte count gets wrong.
      expect(sentOf(sent, "PlaybackPosition")).toEqual([
        { _tag: "PlaybackPosition", responseId: "r1", playedMs: 820 },
      ])
    }),
  )
})
