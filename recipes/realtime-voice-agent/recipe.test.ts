import { describe, it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { expect } from "vitest"
import { RealtimeEvent, type RealtimeInput } from "@effect-uai/core/Realtime"
import * as MockRealtimeSession from "@effect-uai/core/testing/MockRealtimeSession"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { type AgentConfig, runAgent, type StatusEvent } from "./recipe.js"

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

/**
 * Run the agent against a scripted session until it goes quiet, then report
 * both output channels and everything the agent pushed back at the model.
 */
const run = (
  initial: ReadonlyArray<RealtimeEvent>,
  /** Positions the browser would report after cutting playback. */
  played: ReadonlyArray<number> = [],
) =>
  Effect.gen(function* () {
    const mock = MockRealtimeSession.layer({ initial })
    const status = yield* Ref.make<ReadonlyArray<StatusEvent>>([])
    const audio = yield* Ref.make<ReadonlyArray<Uint8Array>>([])

    // The session stays open until its scope closes, so bound the run instead
    // of waiting for an end that never comes.
    yield* runAgent(cfg, toolkit, {
      mic: Stream.make(new Uint8Array([1, 2])),
      typed: Stream.empty,
      // A real browser reports these once it has heard some audio, so let the
      // scripted events land first.
      played: Stream.fromIterable(played).pipe(
        Stream.mapEffect((ms) => Effect.as(Effect.sleep("40 millis"), ms)),
      ),
      sendStatus: (event) => Ref.update(status, (xs) => [...xs, event]),
      sendAudio: (bytes) => Ref.update(audio, (xs) => [...xs, bytes]),
    }).pipe(Effect.scoped, Effect.provide(mock.layer), Effect.timeout("250 millis"), Effect.ignore)

    return {
      status: yield* Ref.get(status),
      audio: yield* Ref.get(audio),
      sent: (yield* mock.recorder).sent,
    }
  })

const sentOf = <T extends RealtimeInput["_tag"]>(
  sent: ReadonlyArray<RealtimeInput>,
  tag: T,
): ReadonlyArray<Extract<RealtimeInput, { readonly _tag: T }>> =>
  sent.filter((i): i is Extract<RealtimeInput, { readonly _tag: T }> => i._tag === tag)

describe("realtime voice agent", () => {
  it.live("runs a tool the model asks for and hands the serialized result back", () =>
    Effect.gen(function* () {
      const { status, sent } = yield* run([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.ToolCall({ responseId: "r1", call: toolCall }),
      ])

      // The microphone reaches the model without waiting for anything.
      expect(sentOf(sent, "Audio")).toHaveLength(1)

      const [result] = sentOf(sent, "ToolResult")
      expect(result?.output.call_id).toBe("call_1")
      expect(result?.output.output).toContain("2026-09-12")
      expect(status.map((e) => e.type)).toEqual(["assistant-started", "tool-call", "tool-done"])
    }),
  )

  it.live("interrupts a tool the model abandoned, so its answer never arrives", () =>
    Effect.gen(function* () {
      const { status, sent } = yield* run([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.ToolCall({ responseId: "r1", call: toolCall }),
        // Lands while the 30 ms tool is still running. Without the interrupt
        // the result would be sent a moment later, well inside the run window.
        RealtimeEvent.ToolCallCancelled({ callIds: ["call_1"] }),
      ])

      expect(sentOf(sent, "ToolResult")).toHaveLength(0)
      expect(status.filter((e) => e.type === "tool-cancelled")).toEqual([
        { type: "tool-cancelled", count: 1 },
      ])
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
