import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import type { TranscriptResult } from "@effect-uai/core/Transcript"
import * as Transcriber from "@effect-uai/core/Transcriber"
import * as ElevenLabsTranscriber from "./ElevenLabsTranscriber.js"

const cfg: ElevenLabsTranscriber.Config = { apiKey: Redacted.make("test-key") }
// FetchHttpClient + globalThis.WebSocket are required for `make`, but these
// tests only exercise the codec + compile-time / runtime branches — no real
// HTTP or WS connection is opened.
const live = ElevenLabsTranscriber.layer(cfg).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
)

const dummyAudio = {
  _tag: "bytes" as const,
  bytes: new Uint8Array([0, 1, 2, 3]),
  mimeType: "audio/wav" as const,
}

describe("ElevenLabsTranscriber input format guard (runtime)", () => {
  it("fails Unsupported for unsupported raw encodings", async () => {
    const program = ElevenLabsTranscriber.ElevenLabsTranscriber.use((s) =>
      Stream.runDrain(
        s.streamTranscriptionFrom(Stream.fromIterable([new Uint8Array([0])]), {
          model: "scribe_v2_realtime",
          inputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100 },
        }),
      ),
    )
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("inputFormat")
    }
  })
})

describe("ElevenLabsTranscriber Layer (compile-time)", () => {
  it("registers `SttStreaming` — `streamTranscriptionFrom` clears R to never", () => {
    const audio: Stream.Stream<Uint8Array> = Stream.fromIterable([new Uint8Array([0])])
    const events = audio.pipe(
      Transcriber.streamTranscriptionFrom({
        model: "scribe_v2_realtime",
        inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000 },
      }),
    )
    const provided = Stream.runDrain(events).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<Effect.Effect<void, AiError.AiError, never>>()
  })

  it("sync `transcribe` requires no marker", () => {
    const t = Transcriber.transcribe({ audio: dummyAudio, model: "scribe_v2" }).pipe(
      Effect.provide(live),
    )
    expectTypeOf(t).toEqualTypeOf<Effect.Effect<TranscriptResult, AiError.AiError, never>>()
  })
})
