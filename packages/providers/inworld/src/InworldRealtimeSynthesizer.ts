/**
 * Realtime variant of `InworldSynthesizer`. Wires `streamSynthesisFrom` to
 * `wss://api.inworld.ai/tts/v1/voice:streamBidirectional` and registers
 * the `TtsIncrementalText` capability marker, so the call compiles
 * against this Layer alone.
 *
 * Sync `synthesize` and chunked `streamSynthesis` reuse the implementations
 * exported from `./InworldSynthesizer.js` — the only added surface here is
 * the WS path.
 */
import { Effect, Layer, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import {
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeRequest,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
  TtsIncrementalText,
} from "@effect-uai/core/SpeechSynthesizer"
import {
  type Config,
  dialogueUnsupportedImpl,
  InworldSynthesizer,
  type InworldSynthesizerService,
  type InworldSynthesizeRequest,
  streamDialogueUnsupportedImpl,
  streamSynthesisImpl,
  synthesizeImpl,
} from "./InworldSynthesizer.js"
import { streamSynthesis as realtimeStream } from "./realtimeTts.js"

export type {
  Config,
  InworldSynthesizerService,
  InworldSynthesizeRequest,
} from "./InworldSynthesizer.js"
export { InworldSynthesizer } from "./InworldSynthesizer.js"

export const make = (cfg: Config) =>
  Effect.map(
    HttpClient.HttpClient.asEffect(),
    (client) =>
      ({
        synthesize: (r) =>
          synthesizeImpl(cfg)(r).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        streamSynthesis: (r) =>
          streamSynthesisImpl(cfg)(r).pipe(Stream.provideService(HttpClient.HttpClient, client)),
        streamSynthesisFrom: (textIn, request) =>
          realtimeStream(cfg)(textIn, request as InworldSynthesizeRequest),
        synthesizeDialogue: dialogueUnsupportedImpl,
        streamSynthesizeDialogue: streamDialogueUnsupportedImpl,
      }) satisfies InworldSynthesizerService,
  )

/**
 * Realtime Layer. Registers `InworldSynthesizer`, the generic
 * `SpeechSynthesizer`, **and** the `TtsIncrementalText` capability
 * marker. The WS constructor uses the `ws` peer dep internally to set
 * the `Authorization: Basic` header — no `Socket.WebSocketConstructor`
 * needed at the call site.
 */
export const layer = (cfg: Config) =>
  Layer.mergeAll(
    Layer.effect(InworldSynthesizer, make(cfg)),
    Layer.effect(
      SpeechSynthesizer,
      Effect.map(
        make(cfg),
        (s): SpeechSynthesizerService => ({
          synthesize: (req: CommonSynthesizeRequest) =>
            s.synthesize(req as InworldSynthesizeRequest),
          streamSynthesis: (req: CommonSynthesizeRequest) =>
            s.streamSynthesis(req as InworldSynthesizeRequest),
          streamSynthesisFrom: (textIn, req: CommonStreamSynthesizeRequest) =>
            s.streamSynthesisFrom(textIn, req),
          synthesizeDialogue: s.synthesizeDialogue,
          streamSynthesizeDialogue: s.streamSynthesizeDialogue,
        }),
      ),
    ),
    Layer.succeed(TtsIncrementalText, undefined),
  )
