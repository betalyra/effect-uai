import { RealtimeEvent } from "@effect-uai/core/Realtime"
import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Stream } from "effect"
import * as Frame from "./Frame.js"
import * as Projection from "./Projection.js"
import type * as Run from "./Run.js"
import { RunId, StreamId } from "./RunEvent.js"
import * as StreamView from "./StreamView.js"

describe("Projection.fromTranscript", () => {
  it.effect("keeps one entry per utterance: partials overwrite it, a final settles it", () =>
    Effect.gen(function* () {
      const events = yield* Stream.make(
        { _tag: "partial", text: "hel" } as const,
        { _tag: "speech-started", atSeconds: 0 } as const,
        {
          _tag: "final",
          text: "hello",
          words: [{ text: "hello", startSeconds: 0, endSeconds: 0.4, confidence: 0.9 }],
        } as const,
        { _tag: "partial", text: "again" } as const,
      ).pipe(Projection.fromTranscript(), Stream.runCollect)

      expect(events).toEqual([
        { type: "data", name: "transcript", id: "0", value: { text: "hel", final: false } },
        {
          type: "data",
          name: "transcript",
          id: "0",
          value: {
            text: "hello",
            final: true,
            words: [{ text: "hello", startSeconds: 0, endSeconds: 0.4 }],
          },
        },
        { type: "data", name: "transcript", id: "1", value: { text: "again", final: false } },
      ])
    }),
  )
})

describe("Projection.fromRealtime", () => {
  const audio = new Uint8Array([1, 2])

  const session = (events: ReadonlyArray<RealtimeEvent>) =>
    Stream.fromIterable(events).pipe(
      Projection.fromRealtime({ channel: 0, format: { sampleRate: 24000 } }),
      Stream.runCollect,
    )

  const r1 = RunId.make("r1")

  const viewOf = (frames: ReadonlyArray<Frame.Frame<Run.Owned>>) =>
    Stream.fromIterable(frames).pipe(
      Frame.sequence(StreamId.make("s")),
      Stream.runCollect,
      Effect.map((sequenced) =>
        sequenced
          .flatMap((f) => (f._tag === "Message" ? [f.message] : []))
          .reduce(StreamView.step, StreamView.initial),
      ),
    )

  it.effect("makes each response a run with its own channel, and its audio media on it", () =>
    Effect.gen(function* () {
      const frames = yield* session([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.OutputTranscriptDelta({ responseId: "r1", text: "Hi" }),
        RealtimeEvent.AudioDelta({ responseId: "r1", bytes: audio }),
      ])
      expect(frames.filter((f) => f._tag === "Media")).toEqual([Frame.media(0, audio)])

      const view = yield* viewOf(frames)
      const run = StreamView.runsOf(view, "assistant")[0]
      expect(run?.status).toBe("streaming")
      expect(view.channels["0"]?.runId).toBe("r1")
    }),
  )

  it.effect("ends an interrupted response as a barge-in and drops what it still sends", () =>
    Effect.gen(function* () {
      const frames = yield* session([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.Interrupted({ responseId: "r1" }),
        RealtimeEvent.AudioDelta({ responseId: "r1", bytes: audio }),
        RealtimeEvent.ResponseDone({ responseId: "r1", reason: "interrupted" }),
      ])
      expect(Arr.some(frames, (f) => f._tag === "Media")).toBe(false)

      const view = yield* viewOf(frames)
      expect(view.runs[r1]?.status).toBe("stopped")
      expect(view.channels).toEqual({})
    }),
  )

  it.effect("closes a cancelled call in the run that made it", () =>
    Effect.gen(function* () {
      const frames = yield* session([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.ToolCall({
          responseId: "r1",
          call: {
            type: "function_call",
            call_id: "c1",
            name: "get_weather",
            arguments: '{"city":"Porto"}',
          },
        }),
        RealtimeEvent.ResponseDone({ responseId: "r1", reason: "complete" }),
        RealtimeEvent.ToolCallCancelled({ callIds: ["c1"] }),
      ])
      const view = yield* viewOf(frames)
      const tool = view.runs[r1]?.blocks.find((b) => b.type === "tool")
      expect(tool).toMatchObject({ status: "failed", input: { city: "Porto" } })
    }),
  )
})

describe("Projection.fromRealtime transcript", () => {
  it.effect("builds a partial from its deltas, then takes the final as the whole utterance", () =>
    Effect.gen(function* () {
      const frames = yield* Stream.make(
        RealtimeEvent.InputTranscript({ text: "what ", final: false }),
        RealtimeEvent.InputTranscript({ text: "time", final: false }),
        RealtimeEvent.InputTranscript({ text: "What time is it?", final: true }),
        RealtimeEvent.InputTranscript({ text: "and", final: false }),
      ).pipe(
        Projection.fromRealtime({ channel: 0, format: { sampleRate: 24000 } }),
        Stream.runCollect,
      )
      const values = frames.flatMap((f) =>
        f._tag === "Message" && f.message.event.type === "data"
          ? [[f.message.event.id, f.message.event.value]]
          : [],
      )
      expect(values).toEqual([
        ["0", { text: "what", final: false }],
        ["0", { text: "what time", final: false }],
        ["0", { text: "What time is it?", final: true }],
        ["1", { text: "and", final: false }],
      ])
    }),
  )
})
