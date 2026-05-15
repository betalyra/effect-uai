/**
 * Realtime variant of `InworldTranscriber`. Wires `streamTranscriptionFrom`
 * to `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional` and
 * registers the `SttStreaming` capability marker, so calls compile against
 * this Layer alone.
 *
 * Sync `transcribe` reuses `transcribeImpl` from `./InworldTranscriber.js` —
 * the only added surface is the WS path.
 */
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import {
  type CommonTranscribeRequest,
  SttStreaming,
  Transcriber,
  type TranscriberService,
} from "@effect-uai/core/Transcriber"
import {
  type Config,
  InworldTranscriber,
  type InworldTranscriberService,
  type InworldTranscribeRequest,
  transcribeImpl,
} from "./InworldTranscriber.js"
import { streamTranscription } from "./realtimeStt.js"

export type {
  Config,
  InworldTranscriberService,
  InworldTranscribeRequest,
} from "./InworldTranscriber.js"
export { InworldTranscriber } from "./InworldTranscriber.js"

export const make = (cfg: Config) =>
  Effect.map(
    HttpClient.HttpClient.asEffect(),
    (client) =>
      ({
        transcribe: (r) =>
          transcribeImpl(cfg)(r).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        streamTranscriptionFrom: (audioIn, request) => streamTranscription(cfg)(audioIn, request),
      }) satisfies InworldTranscriberService,
  )

/**
 * Realtime Layer. Registers `InworldTranscriber`, the generic
 * `Transcriber`, **and** the `SttStreaming` capability marker.
 */
export const layer = (cfg: Config) =>
  Layer.mergeAll(
    Layer.effect(InworldTranscriber, make(cfg)),
    Layer.effect(
      Transcriber,
      Effect.map(
        make(cfg),
        (s): TranscriberService => ({
          transcribe: (req: CommonTranscribeRequest) =>
            s.transcribe(req as InworldTranscribeRequest),
          streamTranscriptionFrom: s.streamTranscriptionFrom,
        }),
      ),
    ),
    Layer.succeed(SttStreaming, undefined),
  )
