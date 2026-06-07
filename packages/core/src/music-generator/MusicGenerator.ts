import { Context, Effect, Function, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type {
  CommonGenerateMusicRequest,
  CommonStreamGenerateMusicRequest,
  GenerateResult,
  MusicSessionInput,
  MusicStreamEvent,
} from "../domain/Music.js"
import type { AudioChunk } from "../domain/Audio.js"

export type {
  CommonGenerateMusicRequest,
  CommonStreamGenerateMusicRequest,
  GenerateResult,
  MusicResult,
  MusicSection,
  MusicSessionControl,
  MusicSessionInput,
  MusicStreamEvent,
  Watermark,
  WeightedPrompt,
} from "../domain/Music.js"

export type MusicGeneratorService = {
  /**
   * One-shot. Prompt in, full audio bytes out. Universally supported.
   * Async/poll-based providers (Suno, Mureka) hide their poll loop
   * inside the adapter, caller still sees a single `Effect`.
   *
   * Returns `GenerateResult` with `primary` plus a `variants` array.
   * Suno and Mureka always return 2 tracks; every other provider
   * returns 1 (and `primary === variants[0]`).
   */
  readonly generate: (
    request: CommonGenerateMusicRequest,
  ) => Effect.Effect<GenerateResult, AiError.AiError>
  /**
   * Prompt in, audio chunks streamed out. Providers without a native
   * chunked-output endpoint (Lyria 3 sync, Mureka, MiniMax, Stable
   * Audio) emulate this by calling `generate` and emitting a single
   * `AudioChunk`, first-class, no `Unsupported`.
   */
  readonly streamGeneration: (
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  /**
   * Bidirectional session: a `Stream` of `MusicSessionInput` (prompts
   * + playback control) flows in, a `Stream` of `MusicStreamEvent`
   * flows out. The session WS / RPC is acquired on first pull and
   * released when the output stream is finalized via `Stream.scoped`.
   *
   * Cross-provider callers send `prompts` (steer the active
   * generation) and `control` (play / pause / stop / reset) — the two
   * actions that converge across interactive-media protocols.
   * Provider-specific model knobs (Lyria RealTime's density /
   * brightness / mute-stems / BPM / scale, etc.) live on the
   * provider-typed service (`LyriaRealtimeGenerator.streamGenerationFrom`),
   * which extends this union with its own `config` variant.
   *
   * Output is `MusicStreamEvent`: `audio` chunks alongside in-band
   * `warning` and `filteredPrompt` events the model emits server-side.
   *
   * Gated by the `MusicInteractiveSession` capability marker on the
   * top-level helper. Providers without bidirectional support don't
   * ship the marker, so calls fail at `Effect.provide` with a type
   * error.
   */
  readonly streamGenerationFrom: <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<MusicStreamEvent, AiError.AiError | E, R>
}

export class MusicGenerator extends Context.Service<MusicGenerator, MusicGeneratorService>()(
  "@betalyra/effect-uai/MusicGenerator",
) {}

/**
 * Capability marker, provided by provider layers whose
 * `streamGenerationFrom` is wired up at the wire level. Currently only
 * Lyria RealTime (via the BidiGenerateMusic WebSocket) ships it.
 * Calling `streamGenerationFrom` while only a non-interactive Layer is
 * in scope fails at `Effect.provide` with a type error.
 *
 * Phantom: the value is `void`; providers register with
 * `Layer.succeed(MusicInteractiveSession, undefined)`.
 */
export class MusicInteractiveSession extends Context.Service<MusicInteractiveSession, void>()(
  "@betalyra/effect-uai/capability/MusicInteractiveSession",
) {}

/** One-shot generation. Returns the full `GenerateResult`. */
export const generate = (
  request: CommonGenerateMusicRequest,
): Effect.Effect<GenerateResult, AiError.AiError, MusicGenerator> =>
  Effect.flatMap(MusicGenerator.asEffect(), (s) => s.generate(request))

/** Prompt in, audio chunks out. */
export const streamGeneration = (
  request: CommonStreamGenerateMusicRequest,
): Stream.Stream<AudioChunk, AiError.AiError, MusicGenerator> =>
  Stream.unwrap(Effect.map(MusicGenerator.asEffect(), (s) => s.streamGeneration(request)))

/**
 * Bidirectional generation. Dual-arity: pipeable (data-last) and
 * direct (data-first). Requires `MusicInteractiveSession` in R,
 * providers without bidirectional support are a type error at provide
 * time.
 *
 * On the cross-provider surface, `input` is `Stream<unknown>` and
 * output is `Stream<MusicStreamEvent>`. Use the provider-typed
 * service (`LyriaRealtimeGenerator`) when you want to construct
 * typed session messages.
 *
 * @example
 * ```ts
 * // Generic surface (opaque input):
 * const audio = inputs.pipe(
 *   MusicGenerator.streamGenerationFrom({ model: "lyria-realtime-exp", prompt: "" }),
 * )
 *
 * // Lyria-typed surface (full config knobs):
 * const audio = inputs.pipe(
 *   LyriaRealtimeGenerator.streamGenerationFrom({ model: "lyria-realtime-exp", prompt: "" }),
 * )
 * ```
 */
export const streamGenerationFrom: {
  (
    request: CommonStreamGenerateMusicRequest,
  ): <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
  ) => Stream.Stream<
    MusicStreamEvent,
    AiError.AiError | E,
    R | MusicGenerator | MusicInteractiveSession
  >
  <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ): Stream.Stream<
    MusicStreamEvent,
    AiError.AiError | E,
    R | MusicGenerator | MusicInteractiveSession
  >
} = Function.dual(
  2,
  <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ): Stream.Stream<
    MusicStreamEvent,
    AiError.AiError | E,
    R | MusicGenerator | MusicInteractiveSession
  > =>
    Stream.unwrap(
      Effect.gen(function* () {
        const s = yield* MusicGenerator.asEffect()
        yield* MusicInteractiveSession.asEffect()
        return s.streamGenerationFrom(input, request)
      }),
    ),
)
