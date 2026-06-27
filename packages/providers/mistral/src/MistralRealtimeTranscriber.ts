/**
 * Realtime variant of `MistralTranscriber`. Wires `streamTranscriptionFrom`
 * to the Voxtral Realtime WebSocket endpoint and registers the `SttStreaming`
 * capability marker, so live-transcription calls compile against this Layer
 * alone (unlike the sync-only `MistralTranscriber` Layer).
 *
 * Pulls in `ws` (optional peer dep) transitively via `./realtimeStt.js`.
 * Node/Bun only — the browser `WebSocket` API can't set the `Authorization`
 * header the WS upgrade requires.
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
  MistralTranscriber,
  type MistralTranscriberService,
  type MistralTranscribeRequest,
  transcribeImpl,
} from "./MistralTranscriber.js"
import { type Config, streamTranscription } from "./realtimeStt.js"

export type { Config } from "./realtimeStt.js"
export {
  MistralTranscriber,
  type MistralTranscriberService,
  type MistralTranscribeRequest,
} from "./MistralTranscriber.js"

export const make = (
  cfg: Config,
): Effect.Effect<MistralTranscriberService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    transcribe: (request) =>
      transcribeImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamTranscriptionFrom: streamTranscription(cfg),
  }))

export const layer = (
  cfg: Config,
): Layer.Layer<MistralTranscriber | Transcriber | SttStreaming, never, HttpClient.HttpClient> =>
  Layer.mergeAll(
    Layer.effect(MistralTranscriber, make(cfg)),
    Layer.effect(
      Transcriber,
      Effect.map(
        make(cfg),
        (s): TranscriberService => ({
          transcribe: (req: CommonTranscribeRequest) =>
            s.transcribe(req as MistralTranscribeRequest),
          streamTranscriptionFrom: s.streamTranscriptionFrom,
        }),
      ),
    ),
    Layer.succeed(SttStreaming, undefined),
  )
