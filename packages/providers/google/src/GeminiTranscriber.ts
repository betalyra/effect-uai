import { Context, Effect, Layer, Match, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { TranscriptResult } from "@effect-uai/core/Transcript"
import {
  type CommonTranscribeRequest,
  Transcriber,
  type TranscriberService,
} from "@effect-uai/core/Transcriber"
import { audioSourceToInlineData, httpStatusError, transportFailure } from "./geminiSpeechCodec.js"
import type { GeminiSttModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Gemini transcription rides on `:generateContent` — the model receives
 * audio plus a textual "transcribe verbatim" prompt and returns plain
 * text. There is no native structured timestamp / diarization channel,
 * so `wordTimestamps` / `diarization` short-circuit with `Unsupported`.
 */
export type GeminiTranscribeRequest = Omit<CommonTranscribeRequest, "model"> & {
  readonly model: GeminiSttModel
}

export type GeminiTranscriberService = {
  readonly transcribe: (
    r: GeminiTranscribeRequest,
  ) => Effect.Effect<TranscriptResult, AiError.AiError>
  readonly streamTranscriptionFrom: TranscriberService["streamTranscriptionFrom"]
}

export class GeminiTranscriber extends Context.Service<
  GeminiTranscriber,
  GeminiTranscriberService
>()("@betalyra/effect-uai/providers/google/GeminiTranscriber") {}

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

// ---------------------------------------------------------------------------
// Prompt builder + capability guards
// ---------------------------------------------------------------------------

const unsupported = (capability: string, reason: string) =>
  new AiError.Unsupported({ provider: "gemini", capability, reason })

const ensureSupported = Match.type<GeminiTranscribeRequest>().pipe(
  Match.when({ wordTimestamps: true }, () =>
    Effect.fail(
      unsupported(
        "wordTimestamps",
        "Gemini's prompt-driven transcription returns plain text — no per-word timing. Use Cloud Speech-to-Text (Chirp 2) for word timestamps.",
      ),
    ),
  ),
  Match.when({ diarization: true }, () =>
    Effect.fail(
      unsupported(
        "diarization",
        "Gemini's prompt-driven transcription does not surface speaker IDs. Use Cloud Speech-to-Text (Chirp 2) for diarization.",
      ),
    ),
  ),
  Match.orElse(() => Effect.void),
)

const biasingHint = (r: GeminiTranscribeRequest) => {
  if (r.prompt === undefined) return ""
  if (typeof r.prompt === "string") return `\nContext: ${r.prompt}`
  return r.prompt.terms.length === 0
    ? ""
    : `\nThe following terms / names appear in the audio: ${r.prompt.terms.join(", ")}.`
}

export const buildPrompt = (r: GeminiTranscribeRequest) =>
  (r.language !== undefined
    ? `Transcribe the audio verbatim in ${r.language}. Return only the transcript text, no preamble.`
    : "Transcribe the audio verbatim. Return only the transcript text, no preamble.") +
  biasingHint(r)

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

const Wire = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Struct({
            parts: Schema.optional(
              Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
            ),
          }),
        ),
      }),
    ),
  ),
})
const decodeWire = Schema.decodeUnknownEffect(Wire)

const collectText = (wire: typeof Wire.Type) =>
  (wire.candidates ?? [])
    .flatMap((c) => c.content?.parts ?? [])
    .flatMap((p) => (p.text !== undefined ? [p.text] : []))
    .join("\n")
    .trim()

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config) => cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"

const transcribeImpl = (cfg: Config) => (request: GeminiTranscribeRequest) =>
  Effect.gen(function* () {
    yield* ensureSupported(request)
    const client = yield* HttpClient.HttpClient
    const inline = yield* audioSourceToInlineData(request.audio)
    const httpRequest = HttpClientRequest.post(
      `${baseUrl(cfg)}/models/${request.model}:generateContent`,
    ).pipe(
      HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyJsonUnsafe({
        contents: [{ parts: [{ text: buildPrompt(request) }, { inlineData: inline }] }],
      }),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(httpStatusError(response.status, text))
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const text = yield* decodeWire(json).pipe(
      Effect.map(collectText),
      Effect.mapError((cause) => new AiError.GenerationFailed({ provider: "gemini", raw: cause })),
      Effect.flatMap((t) =>
        t.length === 0
          ? Effect.fail(
              new AiError.GenerationFailed({
                provider: "gemini",
                raw: {
                  message: "Gemini transcription response had no text part.",
                  hint: "Likely a prompt-safety rejection or the model returned only metadata.",
                  response: json,
                },
              }),
            )
          : Effect.succeed(t),
      ),
    )
    return {
      text,
      ...(request.language !== undefined && { languageCode: request.language }),
      raw: json,
    } satisfies TranscriptResult
  })

const unsupportedStreamFrom: TranscriberService["streamTranscriptionFrom"] = () =>
  Stream.fail(
    new AiError.Unsupported({
      provider: "gemini",
      capability: "streamTranscriptionFrom",
      reason:
        "Gemini transcription via generateContent is sync-only. Use Cloud Speech-to-Text (StreamingRecognize) for live transcription.",
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (cfg: Config) =>
  Effect.map(
    HttpClient.HttpClient.asEffect(),
    (client): GeminiTranscriberService => ({
      transcribe: (r) =>
        transcribeImpl(cfg)(r).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      streamTranscriptionFrom: unsupportedStreamFrom,
    }),
  )

/**
 * Layer registers both `GeminiTranscriber` and the generic
 * `Transcriber`. Does NOT register `SttStreaming` — Gemini's transcription
 * is sync-only, so `streamTranscriptionFrom` against this Layer alone
 * is a compile-time error.
 */
export const layer = (cfg: Config) =>
  Layer.merge(
    Layer.effect(GeminiTranscriber, make(cfg)),
    Layer.effect(
      Transcriber,
      Effect.map(
        make(cfg),
        (s): TranscriberService => ({
          transcribe: (req: CommonTranscribeRequest) =>
            s.transcribe(req as GeminiTranscribeRequest),
          streamTranscriptionFrom: s.streamTranscriptionFrom,
        }),
      ),
    ),
  )
