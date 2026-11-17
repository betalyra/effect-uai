import { describe, it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { expect, expectTypeOf } from "vitest"
import type { ImageSource } from "@effect-uai/core/Image"
import { RealtimeEvent, type RealtimeInput } from "@effect-uai/core/Realtime"
import type { RealtimeVideoInput } from "@effect-uai/core/RealtimeSession"
import * as MockRealtimeSession from "@effect-uai/core/testing/MockRealtimeSession"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Frame from "@effect-uai/ui/Frame"
import type * as Run from "@effect-uai/ui/Run"
import { RunId, StreamId } from "@effect-uai/ui/RunEvent"
import * as StreamView from "@effect-uai/ui/StreamView"
import { CAMERA, MIC, type Up } from "./contract.js"
import { type AssistantConfig, type Frames, runAssistant } from "./recipe.js"

const cfg: AssistantConfig = {
  model: "gemini-3.1-flash-live-preview",
  instructions: "describe what you see",
  voiceId: "Kore",
  inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
}

type ContextOf<T> = T extends Stream.Stream<infer _A, infer _E, infer R> ? R : never

/** Slow enough that a cancellation lands while it is still running. */
const lookUp = Tool.make({
  name: "web_search",
  description: "Search the web.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ query: Schema.String })),
  outputSchema: Schema.Struct({ query: Schema.String, results: Schema.Array(Schema.String) }),
  run: ({ query }) =>
    Effect.succeed({ query, results: ["a result"] }).pipe(Effect.delay("30 millis")),
})

const toolkit = Toolkit.make(lookUp)

const jpeg = (byte: number): ImageSource => ({
  _tag: "bytes",
  bytes: new Uint8Array([byte]),
  mimeType: "image/jpeg",
})

const turn1 = RunId.make("turn_1")

const call = {
  type: "function_call",
  call_id: "fc_1",
  name: "web_search",
  arguments: '{"query":"what is this"}',
  providerData: undefined,
} as const

/**
 * Run the assistant against a scripted session until it goes quiet, with the
 * page sending the mic and `cameraFrames` on the camera channel, then fold
 * what it sent the page into a `StreamView`.
 */
const run = (
  cameraFrames: ReadonlyArray<number>,
  initial: ReadonlyArray<RealtimeEvent> = [],
  frames: Frames = { _tag: "page", source: "camera" },
) =>
  Effect.gen(function* () {
    const mock = MockRealtimeSession.layer({ initial })
    const emitted = yield* Ref.make<ReadonlyArray<Frame.Frame<Run.Owned>>>([])
    const up: Stream.Stream<Frame.Frame<Up>> = Stream.make(
      Frame.media(MIC, new Uint8Array([1, 2])),
      ...cameraFrames.map((byte) => Frame.media(CAMERA, new Uint8Array([byte]))),
    )

    // The session stays open until its scope closes, so bound the run instead
    // of waiting for an end that never comes.
    yield* runAssistant(cfg, toolkit, frames, up).pipe(
      Stream.runForEach((frame) => Ref.update(emitted, (xs) => [...xs, frame])),
      Effect.provide(mock.layer),
      Effect.timeout("250 millis"),
      Effect.ignore,
    )

    const view = yield* Stream.fromIterable(yield* Ref.get(emitted)).pipe(
      Frame.sequence(StreamId.make("camera")),
      Stream.runFold(
        () => StreamView.initial,
        (v, frame) => (frame._tag === "Message" ? StreamView.step(v, frame.message) : v),
      ),
    )
    const tool = view.runs[turn1]?.blocks.find((b) => b.type === "tool")
    return { view, tool, sent: (yield* mock.recorder).sent }
  })

const sentOf = <T extends RealtimeInput["_tag"]>(
  sent: ReadonlyArray<RealtimeInput>,
  tag: T,
): ReadonlyArray<Extract<RealtimeInput, { readonly _tag: T }>> =>
  sent.filter((i): i is Extract<RealtimeInput, { readonly _tag: T }> => i._tag === tag)

describe("camera assistant", () => {
  it.live("forwards every camera frame to the session and counts what it showed", () =>
    Effect.gen(function* () {
      const { view, sent } = yield* run([1, 2])

      expect(sentOf(sent, "VideoFrame").map((i) => i.frame)).toEqual([jpeg(1), jpeg(2)])
      // The count is what the page shows, so it has to follow the frames.
      expect(view.live["frames"]).toBe(2)
      // The page captures, so it is told to, and with what.
      expect(view.channels[String(CAMERA)]?.mimeType).toBe("image/jpeg")
      expect(view.live["source"]).toBe("camera")
    }),
  )

  it.live("takes frames from its own source instead, and offers the page no camera", () =>
    Effect.gen(function* () {
      const { view, sent } = yield* run([9], [], {
        _tag: "own",
        frames: Stream.make(jpeg(1)),
      })

      expect(sentOf(sent, "VideoFrame").map((i) => i.frame)).toEqual([jpeg(1)])
      expect(view.channels[String(CAMERA)]).toBeUndefined()
    }),
  )

  it.live("ends an interrupted answer without answering it, since this wire has no truncate", () =>
    Effect.gen(function* () {
      const { view, sent } = yield* run(
        [],
        [
          RealtimeEvent.ResponseStarted({ responseId: "turn_1" }),
          RealtimeEvent.Interrupted({ responseId: "turn_1" }),
          RealtimeEvent.ResponseDone({ responseId: "turn_1", reason: "interrupted" }),
        ],
      )

      expect(view.runs[turn1]?.status).toBe("stopped")
      expect(sentOf(sent, "PlaybackPosition")).toHaveLength(0)
    }),
  )

  it.live("runs a tool beside the conversation and hands the result back", () =>
    Effect.gen(function* () {
      const { tool, sent } = yield* run(
        [],
        [
          RealtimeEvent.ResponseStarted({ responseId: "turn_1" }),
          RealtimeEvent.ToolCall({ responseId: "turn_1", call }),
        ],
      )

      const [result] = sentOf(sent, "ToolResult")
      expect(result?.output.call_id).toBe("fc_1")
      expect(JSON.stringify(result?.output.output)).toContain("a result")
      expect(tool).toMatchObject({ status: "done", input: { query: "what is this" } })
    }),
  )

  it.live("still interrupts a call the model abandons after the turn ended", () =>
    Effect.gen(function* () {
      const { tool, sent } = yield* run(
        [],
        [
          RealtimeEvent.ResponseStarted({ responseId: "turn_1" }),
          RealtimeEvent.ToolCall({ responseId: "turn_1", call }),
          // Gemini ends the turn before it cancels the call it just made.
          RealtimeEvent.ResponseDone({ responseId: "turn_1", reason: "interrupted" }),
          RealtimeEvent.ToolCallCancelled({ callIds: ["fc_1"] }),
        ],
      )

      expect(sentOf(sent, "ToolResult")).toHaveLength(0)
      expect(tool).toMatchObject({ status: "failed", outcome: { error: "cancelled" } })
    }),
  )

  it("needs a provider with video, so an audio-only session leaves the marker unmet", () => {
    const frames: Frames = { _tag: "page", source: "camera" }
    const audioOnly = runAssistant(cfg, toolkit, frames, Stream.empty).pipe(
      Stream.provide(MockRealtimeSession.layerAudioOnly({}).layer),
    )
    const withVideo = runAssistant(cfg, toolkit, frames, Stream.empty).pipe(
      Stream.provide(MockRealtimeSession.layer({}).layer),
    )

    // An unmet marker is what makes running this against a provider without
    // video a compile error rather than a failure mid-conversation.
    expectTypeOf<ContextOf<typeof audioOnly>>().toEqualTypeOf<RealtimeVideoInput>()
    expectTypeOf<ContextOf<typeof withVideo>>().toEqualTypeOf<never>()
  })
})
