import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import type { AudioChunk } from "@effect-uai/core/Audio"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as MockSynthesizer from "@effect-uai/core/testing/MockSpeechSynthesizer"
import * as MockTranscriber from "@effect-uai/core/testing/MockTranscriber"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import type { Turn } from "@effect-uai/core/Turn"
import * as Frame from "@effect-uai/ui/Frame"
import type * as Run from "@effect-uai/ui/Run"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import * as StreamView from "@effect-uai/ui/StreamView"
import { SPEAKER } from "./contract.js"
import { type PipelineConfig, runPipeline } from "./recipe.js"

// Mock providers ignore model/voice names, so a minimal config suffices. The
// short settle window keeps the test fast.
const testConfig: PipelineConfig = {
  stt: {
    model: "mock-stt",
    inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  },
  llm: { model: "mock-llm", systemPrompt: "test" },
  tts: {
    model: "mock-tts",
    voiceId: "mock",
    outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 48000, channels: 1 },
  },
  utteranceSettle: "20 millis",
}

// ---------------------------------------------------------------------------
// Harness: runs the recipe against mock providers and folds what it emits
// the way the browser does, through `Frame.sequence` and `StreamView`.
// ---------------------------------------------------------------------------

const runRecipe = (script: {
  readonly sttEvents: ReadonlyArray<ReadonlyArray<TranscriptEvent>>
  readonly llmTurns: ReadonlyArray<Turn>
  readonly ttsChunks: ReadonlyArray<ReadonlyArray<AudioChunk>>
}) =>
  Effect.gen(function* () {
    const emitted = yield* Ref.make<ReadonlyArray<Frame.Frame<Run.Owned>>>([])
    const stt = MockTranscriber.layer({ streams: script.sttEvents })
    const lm = MockProvider.layer(script.llmTurns)
    const tts = MockSynthesizer.layer({ streamSynthesisFromChunks: script.ttsChunks })

    yield* runPipeline(testConfig, Stream.make(new Uint8Array([0])), (frame) =>
      Ref.update(emitted, (xs) => [...xs, frame]),
    ).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(stt.layer, lm, tts.layer)))

    const frames = yield* Ref.get(emitted)
    const view = yield* Stream.fromIterable(frames).pipe(
      Frame.sequence(StreamId.make("voice")),
      Stream.runFold(
        () => StreamView.initial,
        (v, frame) => (frame._tag === "Message" ? StreamView.step(v, frame.message) : v),
      ),
    )
    const audio = frames.flatMap((f) => (f._tag === "Media" ? [f] : []))
    return { view, audio, replies: StreamView.runsOf(view, "assistant") }
  })

const audioChunk = (...bytes: ReadonlyArray<number>): AudioChunk => ({
  bytes: new Uint8Array(bytes),
})

const assistantTurn = (text: string): Turn => ({
  stop_reason: "stop",
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
})

const promptOf = (reply: RunView.RunView) =>
  reply.blocks.flatMap((b) => (b.type === "data" && b.name === "prompt" ? [b.value] : []))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice-loop", () => {
  // Live clock: the settle window and the audio pacing are real sleeps.
  it.live("one utterance: a transcript entry, then one reply run with its audio", () =>
    Effect.gen(function* () {
      const { view, audio, replies } = yield* runRecipe({
        sttEvents: [
          [
            { _tag: "partial", text: "hello" },
            { _tag: "final", text: "hello world" },
          ],
        ],
        llmTurns: [assistantTurn("Hi there.")],
        ttsChunks: [[audioChunk(10, 20), audioChunk(30, 40)]],
      })

      expect(view.data["transcript"]).toEqual({ "0": { text: "hello world", final: true } })
      expect(view.channels["0"]?.direction).toBe("up")

      expect(replies).toHaveLength(1)
      const reply = replies[0]!
      expect(reply.status).toBe("completed")
      expect(promptOf(reply)).toEqual(["hello world"])
      expect(RunView.text(reply)).toBe("Hi there.")
      expect(audio).toEqual([
        Frame.media(SPEAKER, new Uint8Array([10, 20])),
        Frame.media(SPEAKER, new Uint8Array([30, 40])),
      ])
      // The reply's channel closed with its run.
      expect(view.channels[String(SPEAKER)]).toBeUndefined()
    }),
  )

  it.live("burst coalescing: two finals within the settle window make one reply", () =>
    Effect.gen(function* () {
      const { view, replies } = yield* runRecipe({
        sttEvents: [
          [
            { _tag: "final", text: "hello" },
            { _tag: "final", text: "what's the weather" },
          ],
        ],
        // ONE scripted turn: a second LLM call would exhaust the mock and fail.
        llmTurns: [assistantTurn("Sunny.")],
        ttsChunks: [[audioChunk(99)]],
      })

      // The page sees both utterances, but only one reply ran, for both.
      expect(Object.keys(view.data["transcript"] ?? {})).toEqual(["0", "1"])
      expect(replies).toHaveLength(1)
      expect(promptOf(replies[0]!)).toEqual(["hello what's the weather"])
    }),
  )
})
