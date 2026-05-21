import { Context, Effect, Layer, Match, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob, AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import {
  type CommonSynthesizeRequest,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
} from "@effect-uai/core/SpeechSynthesizer"
import {
  decodeBase64Audio,
  httpStatusError,
  transportFailure,
  wrapPcmAsWav,
} from "./geminiSpeechCodec.js"
import type { GeminiTtsModel, GeminiVoiceName } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GeminiSynthesizeRequest = Omit<CommonSynthesizeRequest, "model" | "voiceId"> & {
  readonly model: GeminiTtsModel
  readonly voiceId: GeminiVoiceName
}

export type GeminiSynthesizerService = {
  readonly synthesize: (r: GeminiSynthesizeRequest) => Effect.Effect<AudioBlob, AiError.AiError>
  readonly streamSynthesis: (
    r: GeminiSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamSynthesisFrom: SpeechSynthesizerService["streamSynthesisFrom"]
  readonly synthesizeDialogue: SpeechSynthesizerService["synthesizeDialogue"]
  readonly streamSynthesizeDialogue: SpeechSynthesizerService["streamSynthesizeDialogue"]
}

export class GeminiSynthesizer extends Context.Service<
  GeminiSynthesizer,
  GeminiSynthesizerService
>()("@betalyra/effect-uai/providers/google/GeminiSynthesizer") {}

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

// ---------------------------------------------------------------------------
// Codec — Gemini TTS always emits 24 kHz mono signed-16 PCM. Caller picks
// raw bytes or WAV-wrapped.
// ---------------------------------------------------------------------------

const PCM_RATE = 24000
const PCM_CHANNELS = 1

export const realizeOutput = Match.type<AudioFormat["container"]>().pipe(
  Match.when("raw", () =>
    Effect.succeed([
      { container: "raw", encoding: "pcm_s16le", sampleRate: PCM_RATE, channels: PCM_CHANNELS },
      (b: Uint8Array) => b,
    ] as const),
  ),
  Match.when("wav", () =>
    Effect.succeed([
      { container: "wav", encoding: "pcm_s16le", sampleRate: PCM_RATE, channels: PCM_CHANNELS },
      (b: Uint8Array) => wrapPcmAsWav(b, PCM_RATE, PCM_CHANNELS),
    ] as const),
  ),
  Match.whenOr("mp3", "opus", "aac", "flac", "ogg", "webm", (c) =>
    Effect.fail(
      new AiError.Unsupported({
        provider: "gemini",
        capability: "outputFormat",
        reason: `Gemini TTS emits raw 16-bit PCM at 24 kHz. Request "raw" or "wav"; ${c} is unavailable.`,
      }),
    ),
  ),
  Match.exhaustive,
)

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
              Schema.Array(
                Schema.Struct({
                  inlineData: Schema.optional(
                    Schema.Struct({
                      mimeType: Schema.optional(Schema.String),
                      data: Schema.String,
                    }),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
})
const decodeWire = Schema.decodeUnknownEffect(Wire)

const findInline = (wire: typeof Wire.Type) =>
  (wire.candidates ?? [])
    .flatMap((c) => c.content?.parts ?? [])
    .find((p) => p.inlineData !== undefined)?.inlineData

const ttsBody = (r: GeminiSynthesizeRequest) => ({
  contents: [{ parts: [{ text: r.text }] }],
  generationConfig: {
    responseModalities: ["AUDIO"],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: r.voiceId } } },
  },
})

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config) => cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"

const synthesizeImpl = (cfg: Config) => (request: GeminiSynthesizeRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const [format, wrap] = yield* realizeOutput(request.outputFormat?.container ?? "raw")
    const httpRequest = HttpClientRequest.post(
      `${baseUrl(cfg)}/models/${request.model}:generateContent`,
    ).pipe(
      HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyJsonUnsafe(ttsBody(request)),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const inline = yield* decodeWire(json).pipe(
      Effect.map(findInline),
      Effect.mapError((cause) => new AiError.GenerationFailed({ provider: "gemini", raw: cause })),
      Effect.flatMap((found) =>
        found === undefined
          ? Effect.fail(
              new AiError.GenerationFailed({
                provider: "gemini",
                raw: {
                  message: "Gemini TTS response had no inlineData audio part.",
                  hint: "Likely a prompt-safety rejection or the model didn't honour responseModalities.",
                  response: json,
                },
              }),
            )
          : Effect.succeed(found),
      ),
    )
    const pcm = yield* decodeBase64Audio(inline.data)
    return { format, bytes: wrap(pcm) } satisfies AudioBlob
  })

const unsupportedStreamFrom: SpeechSynthesizerService["streamSynthesisFrom"] = () =>
  Stream.fail(
    new AiError.Unsupported({
      provider: "gemini",
      capability: "streamSynthesisFrom",
      reason:
        "Gemini TTS via generateContent is sync-only. Use Cloud Text-to-Speech (Chirp 3 HD) for incremental text-in.",
    }),
  )

const unsupportedDialogue: SpeechSynthesizerService["synthesizeDialogue"] = () =>
  Effect.fail(
    new AiError.Unsupported({
      provider: "gemini",
      capability: "synthesizeDialogue",
      reason:
        "Gemini API (generativelanguage.googleapis.com) does not expose a multi-speaker endpoint. Use Cloud Text-to-Speech (`@effect-uai/google-speech`) with Gemini TTS for multi-speaker.",
    }),
  )

const unsupportedStreamDialogue: SpeechSynthesizerService["streamSynthesizeDialogue"] = () =>
  Stream.fail(
    new AiError.Unsupported({
      provider: "gemini",
      capability: "streamSynthesizeDialogue",
      reason:
        "Gemini API (generativelanguage.googleapis.com) does not expose a multi-speaker endpoint. Use Cloud Text-to-Speech (`@effect-uai/google-speech`) with Gemini TTS for multi-speaker.",
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (cfg: Config) =>
  Effect.map(
    HttpClient.HttpClient.asEffect(),
    (client): GeminiSynthesizerService => ({
      synthesize: (r) =>
        synthesizeImpl(cfg)(r).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      streamSynthesis: (r) =>
        Stream.fromEffect(synthesizeImpl(cfg)(r)).pipe(
          Stream.map((b): AudioChunk => ({ bytes: b.bytes })),
          Stream.provideService(HttpClient.HttpClient, client),
        ),
      streamSynthesisFrom: unsupportedStreamFrom,
      synthesizeDialogue: unsupportedDialogue,
      streamSynthesizeDialogue: unsupportedStreamDialogue,
    }),
  )

/**
 * Layer registers both `GeminiSynthesizer` and the generic
 * `SpeechSynthesizer`. Does NOT register `TtsIncrementalText` — Gemini
 * TTS is sync-only at the wire level, so `streamSynthesisFrom` against
 * this Layer alone is a compile-time error.
 */
export const layer = (cfg: Config) =>
  Layer.merge(
    Layer.effect(GeminiSynthesizer, make(cfg)),
    Layer.effect(
      SpeechSynthesizer,
      Effect.map(
        make(cfg),
        (s): SpeechSynthesizerService => ({
          synthesize: (req: CommonSynthesizeRequest) =>
            s.synthesize(req as GeminiSynthesizeRequest),
          streamSynthesis: (req: CommonSynthesizeRequest) =>
            s.streamSynthesis(req as GeminiSynthesizeRequest),
          streamSynthesisFrom: s.streamSynthesisFrom,
          synthesizeDialogue: s.synthesizeDialogue,
          streamSynthesizeDialogue: s.streamSynthesizeDialogue,
        }),
      ),
    ),
  )
