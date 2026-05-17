import {
  Array as Arr,
  Context,
  Effect,
  Encoding,
  Layer,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import type {
  CommonGenerateMusicRequest,
  CommonStreamGenerateMusicRequest,
  MusicResult,
  MusicSessionInput,
  WeightedPrompt,
} from "@effect-uai/core/Music"
import { MusicGenerator, type MusicGeneratorService } from "@effect-uai/core/MusicGenerator"
import type { LyriaModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Lyria-typed generate request. Narrows `model` to `LyriaModel`. The
 * Lyria sync API (`generateContent`) accepts only `audio/mp3` and
 * `audio/wav` output; `bpm`, `scale`, `instrumental` etc. on the
 * `CommonGenerateMusicRequest` are flattened into the prompt text
 * because the public API does not expose them as structured fields.
 */
export type LyriaGenerateRequest = Omit<CommonGenerateMusicRequest, "model"> & {
  readonly model: LyriaModel
}

export type LyriaGeneratorService = {
  readonly generate: (request: LyriaGenerateRequest) => Effect.Effect<MusicResult, AiError.AiError>
  readonly streamGeneration: (
    request: LyriaGenerateRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamGenerationFrom: <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R>
}

export class LyriaGenerator extends Context.Service<LyriaGenerator, LyriaGeneratorService>()(
  "@betalyra/effect-uai/providers/google/LyriaGenerator",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec — request → prompt text + response_format
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
 * Is this a Lyria 3 Clip model variant? Clip is fixed at 30 s MP3 — it
 * does not accept a `responseFormat` on `generationConfig` (the live
 * API rejects unknown fields, despite what the docs imply). Pro
 * accepts the documented `responseFormat` knob.
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

/**
 * Collapse `prompts | WeightedPrompt[]` into a single prompt string and
 * splice in non-structural hints (`lyrics`, `bpm`, `scale`,
 * `instrumental`, `durationSeconds`). The Lyria 3 sync API only takes
 * one text part — every condition lives inline.
 */
export const buildPrompt = (request: CommonGenerateMusicRequest): string => {
  const promptText = Match.value(request.prompts).pipe(
    Match.when(Match.string, (s) => s),
    Match.orElse((ws: ReadonlyArray<WeightedPrompt>) =>
      Arr.map(ws, (w) =>
        w.weight !== undefined && w.weight !== 1 ? `${w.text} (weight ${w.weight})` : w.text,
      ).join(". "),
    ),
  )
  const hints = Arr.getSomes([
    request.instrumental === true ? Option.some("Instrumental only — no vocals.") : Option.none(),
    request.bpm !== undefined ? Option.some(`BPM: ${request.bpm}.`) : Option.none(),
    request.scale !== undefined ? Option.some(`Key/scale: ${request.scale}.`) : Option.none(),
    request.durationSeconds !== undefined
      ? Option.some(`Target duration: ${request.durationSeconds}s.`)
      : Option.none(),
  ])
  const lyricsBlock =
    request.lyrics !== undefined && request.instrumental !== true
      ? `\n\nLyrics:\n${request.lyrics}`
      : ""
  return [promptText, ...hints].join(" ") + lyricsBlock
}

// ---------------------------------------------------------------------------
// Wire response schema — just enough to find audio + optional lyrics text
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
  ): Effect.Effect<MusicResult, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const requestedContainer = (request.outputFormat?.container ??
        "mp3") satisfies AudioFormat["container"]
      const mimeType = yield* containerToMimeType(requestedContainer)
      // Clip is fixed 30 s mp3 — reject wav up front rather than sending
      // a `responseFormat` that the live API ignores or rejects.
      if (isClipModel(request.model) && mimeType === "audio/wav") {
        return yield* new AiError.Unsupported({
          provider: "lyria",
          capability: "outputFormat",
          reason: `lyria-3-clip-preview is fixed at audio/mp3. Use lyria-3-pro-preview for audio/wav output.`,
        })
      }
      const promptText = buildPrompt(request)
      const body = isClipModel(request.model)
        ? { contents: [{ parts: [{ text: promptText }] }] }
        : {
            contents: [{ parts: [{ text: promptText }] }],
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
        // No audio came back. Most common cause: Lyria filtered the prompt
        // (named-artist references, copyrighted lyrics, etc.). Surface the
        // full response body — text parts, finish reasons, prompt-feedback
        // blocks — so the caller can see why.
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
      return {
        format: realizedFormat(mimeType),
        bytes,
        ...(text !== undefined && { lyrics: text }),
        watermark: { kind: "synthid" },
      } satisfies MusicResult
    })

const streamGenerationImpl =
  (cfg: Config) =>
  (
    request: LyriaGenerateRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.map(generateImpl(cfg)(request), (result) =>
        Stream.succeed<AudioChunk>({ bytes: result.bytes }),
      ),
    )

/**
 * Lyria 3 sync has no bidirectional session at the wire level — that's
 * Lyria RealTime (Phase 1b, separate Layer). The provider Layer here
 * also does NOT register `MusicInteractiveSession`, so callers using
 * `MusicGenerator.streamGenerationFrom` against only this Layer get a
 * compile-time error before this runtime fallback ever fires.
 */
const streamGenerationFromUnsupported = <E, R>(
  _input: Stream.Stream<MusicSessionInput, E, R>,
  _request: CommonStreamGenerateMusicRequest,
): Stream.Stream<AudioChunk, AiError.AiError | E, R> => {
  const fail: Stream.Stream<AudioChunk, AiError.AiError | E, R> = Stream.fail(
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
 * Does NOT register the `MusicInteractiveSession` capability marker —
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
          generate: (req: CommonGenerateMusicRequest) => s.generate(req as LyriaGenerateRequest),
          streamGeneration: (req: CommonStreamGenerateMusicRequest) =>
            s.streamGeneration(req as LyriaGenerateRequest),
          streamGenerationFrom: s.streamGenerationFrom,
        }),
      ),
    ),
  )
