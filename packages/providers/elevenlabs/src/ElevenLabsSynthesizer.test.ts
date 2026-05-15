import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob } from "@effect-uai/core/Audio"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as ElevenLabsSynthesizer from "./ElevenLabsSynthesizer.js"

const cfg: ElevenLabsSynthesizer.Config = { apiKey: Redacted.make("test-key") }
// FetchHttpClient + globalThis.WebSocket are required for `make`, but these
// tests only exercise the codec and compile-time gating — no real network
// call is made.
const live = ElevenLabsSynthesizer.layer(cfg).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
)

describe("ElevenLabsSynthesizer Layer (compile-time)", () => {
  it("registers `TtsIncrementalText` — `streamSynthesisFrom` clears R to never", () => {
    const tokens: Stream.Stream<string> = Stream.fromIterable(["hello ", "world"])
    const audio = tokens.pipe(
      SpeechSynthesizer.streamSynthesisFrom({
        model: "eleven_flash_v2_5",
        voiceId: "JBFqnCBsd6RMkjVDRZzb",
      }),
    )
    const program = Stream.runDrain(audio).pipe(Effect.provide(live))
    expectTypeOf(program).toEqualTypeOf<Effect.Effect<void, AiError.AiError, never>>()
  })

  it("sync `synthesize` and chunked `streamSynthesis` require no marker", () => {
    const synth = SpeechSynthesizer.synthesize({
      text: "hi",
      model: "eleven_multilingual_v2",
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
    }).pipe(Effect.provide(live))
    expectTypeOf(synth).toEqualTypeOf<Effect.Effect<AudioBlob, AiError.AiError, never>>()

    const _stream = Stream.runCollect(
      SpeechSynthesizer.streamSynthesis({
        text: "hi",
        model: "eleven_multilingual_v2",
        voiceId: "JBFqnCBsd6RMkjVDRZzb",
      }),
    ).pipe(Effect.provide(live))
    expect(_stream).toBeDefined()
  })
})
