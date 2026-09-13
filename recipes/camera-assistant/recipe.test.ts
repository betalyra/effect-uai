import { describe, it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { expect, expectTypeOf } from "vitest"
import type { ImageSource } from "@effect-uai/core/Image"
import { RealtimeEvent, type RealtimeInput } from "@effect-uai/core/Realtime"
import type { RealtimeVideoInput } from "@effect-uai/core/RealtimeSession"
import * as MockRealtimeSession from "@effect-uai/core/testing/MockRealtimeSession"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { type AssistantConfig, runAssistant, type StatusEvent } from "./recipe.js"

const cfg: AssistantConfig = {
  model: "gemini-3.1-flash-live-preview",
  instructions: "describe what you see",
  voiceId: "Kore",
  inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
}

type ContextOf<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never

/** Slow enough that a cancellation lands while it is still running. */
const lookUp = Tool.make({
  name: "web_search",
  description: "Search the web.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ query: Schema.String })),
  run: ({ query }) =>
    Effect.succeed({ query, results: ["a result"] }).pipe(Effect.delay("30 millis")),
})

const toolkit = Toolkit.make(lookUp)

const jpeg = (byte: number): ImageSource => ({
  _tag: "bytes",
  bytes: new Uint8Array([byte]),
  mimeType: "image/jpeg",
})

const run = (frames: ReadonlyArray<ImageSource>, initial: ReadonlyArray<RealtimeEvent> = []) =>
  Effect.gen(function* () {
    const mock = MockRealtimeSession.layer({ initial })
    const status = yield* Ref.make<ReadonlyArray<StatusEvent>>([])

    // The session stays open until its scope closes, so bound the run instead
    // of waiting for an end that never comes.
    yield* runAssistant(cfg, toolkit, {
      mic: Stream.make(new Uint8Array([1, 2])),
      typed: Stream.empty,
      frames: Stream.fromIterable(frames),
      sendStatus: (event) => Ref.update(status, (xs) => [...xs, event]),
      sendAudio: () => Effect.void,
    }).pipe(Effect.scoped, Effect.provide(mock.layer), Effect.timeout("250 millis"), Effect.ignore)

    return { status: yield* Ref.get(status), sent: (yield* mock.recorder).sent }
  })

const sentOf = <T extends RealtimeInput["_tag"]>(
  sent: ReadonlyArray<RealtimeInput>,
  tag: T,
): ReadonlyArray<Extract<RealtimeInput, { readonly _tag: T }>> =>
  sent.filter((i): i is Extract<RealtimeInput, { readonly _tag: T }> => i._tag === tag)

describe("camera assistant", () => {
  it.live("forwards every camera frame to the session and counts what it showed", () =>
    Effect.gen(function* () {
      const { status, sent } = yield* run([jpeg(1), jpeg(2)])

      expect(sentOf(sent, "VideoFrame").map((i) => i.frame)).toEqual([jpeg(1), jpeg(2)])
      // The count is what the page shows, so it has to follow the frames.
      expect(status.filter((e) => e.type === "frames")).toEqual([
        { type: "frames", count: 1 },
        { type: "frames", count: 2 },
      ])
    }),
  )

  it.live("reports an interruption without answering it, since this wire has no truncate", () =>
    Effect.gen(function* () {
      const { status, sent } = yield* run(
        [],
        [
          RealtimeEvent.ResponseStarted({ responseId: "turn_1" }),
          RealtimeEvent.Interrupted({ responseId: "turn_1" }),
          RealtimeEvent.ResponseDone({ responseId: "turn_1", reason: "interrupted" }),
        ],
      )

      expect(status.map((e) => e.type)).toEqual([
        "assistant-started",
        "interrupted",
        "assistant-done",
      ])
      expect(sentOf(sent, "PlaybackPosition")).toHaveLength(0)
    }),
  )

  it.live("runs a tool beside the conversation and hands the result back", () =>
    Effect.gen(function* () {
      const { status, sent } = yield* run(
        [],
        [
          RealtimeEvent.ResponseStarted({ responseId: "turn_1" }),
          RealtimeEvent.ToolCall({
            responseId: "turn_1",
            call: {
              type: "function_call",
              call_id: "fc_1",
              name: "web_search",
              arguments: '{"query":"what is this"}',
              providerData: undefined,
            },
          }),
        ],
      )

      const [result] = sentOf(sent, "ToolResult")
      expect(result?.output.call_id).toBe("fc_1")
      expect(result?.output.output).toContain("a result")
      expect(status.map((e) => e.type)).toEqual(["assistant-started", "tool-call", "tool-done"])
    }),
  )

  it("needs a provider with video, so an audio-only session leaves the marker unmet", () => {
    const io = {
      mic: Stream.empty,
      typed: Stream.empty,
      frames: Stream.empty,
      sendStatus: () => Effect.void,
      sendAudio: () => Effect.void,
    }
    const audioOnly = runAssistant(cfg, toolkit, io).pipe(
      Effect.provide(MockRealtimeSession.layerAudioOnly({}).layer),
      Effect.scoped,
    )
    const withVideo = runAssistant(cfg, toolkit, io).pipe(
      Effect.provide(MockRealtimeSession.layer({}).layer),
      Effect.scoped,
    )

    // An unmet marker is what makes running this against a provider without
    // video a compile error rather than a failure mid-conversation.
    expectTypeOf<ContextOf<typeof audioOnly>>().toEqualTypeOf<RealtimeVideoInput>()
    expectTypeOf<ContextOf<typeof withVideo>>().toEqualTypeOf<never>()
  })
})
