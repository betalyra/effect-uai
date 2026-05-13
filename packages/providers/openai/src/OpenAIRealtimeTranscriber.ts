/**
 * Realtime variant of `OpenAITranscriber`. Wires `streamTranscriptionFrom`
 * to `wss://api.openai.com/v1/realtime?intent=transcription` and registers
 * the `SttStreaming` capability marker, so calls compile against this Layer
 * alone (unlike the sync-only `OpenAITranscriber` Layer).
 *
 * Pulls in `ws` (peer dep) transitively via `./realtimeStt.js`. Node/Bun only
 * — the browser `WebSocket` API can't set the `Authorization` header that
 * OpenAI requires on the WS upgrade.
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
  OpenAITranscriber,
  type OpenAITranscriberService,
  type OpenAITranscribeRequest,
  transcribeImpl,
} from "./OpenAITranscriber.js"
import { streamTranscription } from "./realtimeStt.js"

export type {
  Config,
  OpenAITranscriberService,
  OpenAITranscribeRequest,
} from "./OpenAITranscriber.js"
export { OpenAITranscriber } from "./OpenAITranscriber.js"

export const make = (
  cfg: Config,
): Effect.Effect<OpenAITranscriberService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    transcribe: (request) =>
      transcribeImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamTranscriptionFrom: streamTranscription(cfg),
  }))

export const layer = (
  cfg: Config,
): Layer.Layer<OpenAITranscriber | Transcriber | SttStreaming, never, HttpClient.HttpClient> =>
  Layer.mergeAll(
    Layer.effect(OpenAITranscriber, make(cfg)),
    Layer.effect(
      Transcriber,
      Effect.map(
        make(cfg),
        (s): TranscriberService => ({
          transcribe: (req: CommonTranscribeRequest) =>
            s.transcribe(req as OpenAITranscribeRequest),
          streamTranscriptionFrom: s.streamTranscriptionFrom,
        }),
      ),
    ),
    Layer.succeed(SttStreaming, undefined),
  )
