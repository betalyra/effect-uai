import {
  Context,
  Duration,
  Effect,
  Encoding,
  Layer,
  Match,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import { warnDroppedWhen } from "@effect-uai/core/Capabilities"
import type {
  CommonGenerateMusicRequest,
  CommonStreamGenerateMusicRequest,
  GenerateResult,
  MusicResult,
  MusicSessionInput,
  MusicStreamEvent,
} from "@effect-uai/core/Music"
import { singleVariant } from "@effect-uai/core/Music"
import { MusicGenerator, type MusicGeneratorService } from "@effect-uai/core/MusicGenerator"
import type { LyriaModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Lyria-typed generate request. Narrows `model` to `LyriaModel`.
 *
 * Lyria 3 sync `generateContent` has no structured wire fields for
 * `lyrics` / `duration` / `seed` / `instrumental` / `bpm` / `scale` /
 * etc. Those fields on the Common request are logged as
 * dropped-bucket-2 hints; the adapter never rewrites or augments the
 * caller's prompt on their behalf. If you want lyrics or vocal
 * suppression, include them in your `prompt` text yourself.
 *
 * Output format: only `audio/mp3` and `audio/wav` are accepted; other
 * containers fail `Unsupported`. The Clip model variant is fixed at
 * `audio/mp3`.
 */
export type LyriaGenerateRequest = Omit<CommonGenerateMusicRequest, "model"> & {
  readonly model: LyriaModel
}

export type LyriaGeneratorService = {
  readonly generate: (
    request: LyriaGenerateRequest,
  ) => Effect.Effect<GenerateResult, AiError.AiError>
  readonly streamGeneration: (
    request: LyriaGenerateRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamGenerationFrom: <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<MusicStreamEvent, AiError.AiError | E, R>
}

export class LyriaGenerator extends Context.Service<LyriaGenerator, LyriaGeneratorService>()(
  "@betalyra/effect-uai/providers/google/LyriaGenerator",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec: AudioFormat → Lyria mimeType
// ---------------------------------------------------------------------------

export type LyriaResponseMimeType = "audio/mp3" | "audio/wav"

export const containerToMimeType: (
  container: AudioFormat["container"],
) => Effect.Effect<LyriaResponseMimeType, AiError.AiError> = Match.type<
  AudioFormat["container"]
>().pipe(
  Match.when("mp3", () => Effect.succeed<LyriaResponseMimeType>("audio/mp3")),
  Match.when("wav", () => Effect.succeed<LyriaResponseMimeType>("audio/wav")),
  Match.whenOr("ogg", "opus", "flac", "aac", "webm", "raw", (c) =>
    Effect.fail(
      new AiError.Unsupported({
        provider: "lyria",
        capability: "outputFormat",
        reason: `Lyria 3 only produces audio/mp3 or audio/wav; ${c} is not available. Use container: "mp3" or "wav".`,
      }),
    ),
  ),
  Match.exhaustive,
)

/**
 * Is this a Lyria 3 Clip model variant? Clip is fixed at 30 s MP3, it
 * does not accept a `responseFormat` on `generationConfig` (the live
 * API rejects unknown fields). Pro accepts the documented
 * `responseFormat` knob.
 */
const isClipModel = (model: string): boolean => model.includes("clip")

export const realizedFormat: (mime: LyriaResponseMimeType) => AudioFormat =
  Match.type<LyriaResponseMimeType>().pipe(
    Match.when(
      "audio/mp3",
      (): AudioFormat => ({ container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 }),
    ),
    Match.when(
      "audio/wav",
      (): AudioFormat => ({
        container: "wav",
        encoding: "pcm_s16le",
        sampleRate: 44100,
        channels: 2,
      }),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Bucket-2 warn-and-drop for Common fields Lyria 3 can't honor
// ---------------------------------------------------------------------------

/**
 * Warn (don't fail) when the caller passed Common fields Lyria 3 has
 * no wire field for. Bucket-2 per capabilities policy: provider has
 * no structured interpretation; the output is still valid music, just
 * less aligned with the caller's hint. We never embed these into the
 * prompt on the caller's behalf, prompt construction is the
 * developer's job.
 */
const warnDroppedHints = (request: LyriaGenerateRequest): Effect.Effect<void> =>
  Effect.all(
    [
      warnDroppedWhen(request.lyrics, {
        provider: "lyria",
        capability: "lyrics",
        field: "lyrics",
        reason:
          "Lyria 3 sync has no `lyrics` wire field. If you want vocals to follow specific lyrics, embed them in your prompt yourself (e.g. with `[Verse]` / `[Chorus]` tags).",
      }),
      warnDroppedWhen(
        request.duration !== undefined ? Duration.toMillis(request.duration) : undefined,
        {
          provider: "lyria",
          capability: "duration",
          field: "duration",
          reason:
            "Lyria 3 clip is fixed at 30 s; pro derives duration from prompt content. There is no wire field for duration. If you want to steer length, mention it in your prompt.",
        },
      ),
      warnDroppedWhen(request.seed, {
        provider: "lyria",
        capability: "seed",
        field: "seed",
        reason:
          "Lyria 3 (Gemini surface) does not expose a seed parameter. Output is non-deterministic across identical prompts. Use Lyria 2 (Vertex) for seeded generation.",
      }),
    ],
    { discard: true },
  )

// ---------------------------------------------------------------------------
// Wire response schema
// ---------------------------------------------------------------------------

const InlineData = Schema.Struct({
  mimeType: Schema.optional(Schema.String),
  data: Schema.String,
})

const Part = Schema.Struct({
  text: Schema.optional(Schema.String),
  inlineData: Schema.optional(InlineData),
})

const Content = Schema.Struct({
  parts: Schema.optional(Schema.Array(Part)),
})

const Candidate = Schema.Struct({
  content: Schema.optional(Content),
})

const Wire = Schema.Struct({
  candidates: Schema.optional(Schema.Array(Candidate)),
})

const decodeWire = Schema.decodeUnknownEffect(Wire)

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config): string =>
  cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "lyria", raw: cause })

const httpStatusError: (status: number, body: string) => AiError.AiError = (status, body) =>
  Match.value(status).pipe(
    Match.when(
      429,
      (): AiError.AiError => new AiError.RateLimited({ provider: "lyria", raw: body }),
    ),
    Match.whenOr(
      408,
      504,
      (): AiError.AiError => new AiError.Timeout({ provider: "lyria", raw: body }),
    ),
    Match.when(
      401,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "lyria", subtype: "auth", raw: body }),
    ),
    Match.when(
      403,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "lyria", subtype: "permission", raw: body }),
    ),
    Match.when(
      402,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "lyria", subtype: "billing", raw: body }),
    ),
    Match.when(
      (n) => n >= 500,
      (n): AiError.AiError => new AiError.Unavailable({ provider: "lyria", status: n, raw: body }),
    ),
    Match.orElse(
      (): AiError.AiError => new AiError.InvalidRequest({ provider: "lyria", raw: body }),
    ),
  )

const decodeBase64ToBytes = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(new AiError.InvalidRequest({ provider: "lyria", param: "audio", raw: cause })),
  })

/**
 * Find the first inline-data audio part and the concatenated text parts
 * from a Wire response.
 */
const extractParts = (
  wire: typeof Wire.Type,
): { readonly inline?: typeof InlineData.Type; readonly text?: string } => {
  const allParts = (wire.candidates ?? []).flatMap((c) => c.content?.parts ?? [])
  const inline = allParts.find((p) => p.inlineData !== undefined)?.inlineData
  const textParts = allParts.flatMap((p) => (p.text !== undefined ? [p.text] : []))
  const text = textParts.length === 0 ? undefined : textParts.join("\n")
  return {
    ...(inline !== undefined && { inline }),
    ...(text !== undefined && { text }),
  }
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const generateImpl =
  (cfg: Config) =>
  (
    request: LyriaGenerateRequest,
  ): Effect.Effect<GenerateResult, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const requestedContainer = (request.outputFormat?.container ??
        "mp3") satisfies AudioFormat["container"]
      const requestedMime = yield* containerToMimeType(requestedContainer)
      // lyria-3-clip-preview has no `responseFormat` wire field and always
      // emits mp3, so there is no format to send and no 400 to surface. Rather
      // than keep a per-model table that rejects `wav`, report the format the
      // model actually produces (mp3) so the result is never mislabeled.
      // lyria-3-pro honours the requested container.
      const mimeType = isClipModel(request.model) ? ("audio/mp3" as const) : requestedMime
      yield* warnDroppedHints(request)
      const body = isClipModel(request.model)
        ? { contents: [{ parts: [{ text: request.prompt }] }] }
        : {
            contents: [{ parts: [{ text: request.prompt }] }],
            generationConfig: {
              responseModalities: ["AUDIO", "TEXT"],
              responseFormat: { audio: { mimeType } },
            },
          }
      const httpRequest = HttpClientRequest.post(
        `${baseUrl(cfg)}/models/${request.model}:generateContent`,
      ).pipe(
        HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
        HttpClientRequest.bodyJsonUnsafe(body),
      )
      const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* httpStatusError(response.status, text)
      }
      const json = yield* response.json.pipe(Effect.mapError(transportFailure))
      const wire = yield* decodeWire(json).pipe(
        Effect.mapError(
          (cause): AiError.AiError =>
            new AiError.GenerationFailed({ provider: "lyria", raw: cause }),
        ),
      )
      const { inline, text } = extractParts(wire)
      if (inline === undefined) {
        return yield* new AiError.GenerationFailed({
          provider: "lyria",
          raw: {
            message: "Lyria response had no inlineData audio part.",
            hint: "Likely a prompt-filter rejection. Lyria filters references to real artists / copyrighted song lyrics. Rephrase with descriptive style language instead of artist names.",
            textParts: text,
            response: json,
          },
        })
      }
      const bytes = yield* decodeBase64ToBytes(inline.data)
      const result: MusicResult = {
        audio: { format: realizedFormat(mimeType), bytes },
        provider: "lyria",
        ...(text !== undefined && { lyrics: text }),
        watermark: "synthid",
      }
      return singleVariant(result)
    })

const streamGenerationImpl =
  (cfg: Config) =>
  (
    request: LyriaGenerateRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.map(generateImpl(cfg)(request), (result) =>
        Stream.succeed<AudioChunk>({ bytes: result.primary.audio.bytes }),
      ),
    )

/**
 * Lyria 3 sync has no bidirectional session at the wire level, that's
 * Lyria RealTime (separate Layer). The provider Layer here also does
 * NOT register `MusicInteractiveSession`, so callers using
 * `MusicGenerator.streamGenerationFrom` against only this Layer get a
 * compile-time error before this runtime fallback ever fires.
 */
const streamGenerationFromUnsupported = <E, R>(
  _input: Stream.Stream<MusicSessionInput, E, R>,
  _request: CommonStreamGenerateMusicRequest,
): Stream.Stream<MusicStreamEvent, AiError.AiError | E, R> => {
  const fail: Stream.Stream<MusicStreamEvent, AiError.AiError | E, R> = Stream.fail(
    new AiError.Unsupported({
      provider: "lyria",
      capability: "streamGenerationFrom",
      reason:
        "Lyria 3 sync does not support bidirectional sessions. Use the Lyria RealTime Layer (WebSocket BidiGenerateMusic) for interactive mid-session prompts.",
    }),
  )
  return fail
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<LyriaGeneratorService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    generate: (request) =>
      generateImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamGeneration: (request) =>
      streamGenerationImpl(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client)),
    streamGenerationFrom: streamGenerationFromUnsupported,
  }))

/**
 * Layer that registers both the provider-specific `LyriaGenerator` tag
 * and the generic `MusicGenerator` tag.
 *
 * Does NOT register the `MusicInteractiveSession` capability marker,
 * Lyria 3 sync has no bidirectional session at the wire level. Code
 * calling `MusicGenerator.streamGenerationFrom` will fail to typecheck
 * against this Layer alone, which is the intended UX.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<LyriaGenerator | MusicGenerator, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(LyriaGenerator, make(cfg)),
    Layer.effect(
      MusicGenerator,
      Effect.map(
        make(cfg),
        (s): MusicGeneratorService => ({
          generate: (req: CommonGenerateMusicRequest) =>
            s.generate({ ...req, model: req.model as LyriaModel }),
          streamGeneration: (req: CommonStreamGenerateMusicRequest) =>
            s.streamGeneration({ ...req, model: req.model as LyriaModel }),
          streamGenerationFrom: s.streamGenerationFrom,
        }),
      ),
    ),
  )
