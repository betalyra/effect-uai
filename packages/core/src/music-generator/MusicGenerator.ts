import { Context, Effect, Function, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { AudioChunk } from "../domain/Audio.js"
import type {
  CommonGenerateMusicRequest,
  CommonStreamGenerateMusicRequest,
  MusicResult,
  MusicSessionInput,
} from "../domain/Music.js"

export type {
  CommonGenerateMusicRequest,
  CommonStreamGenerateMusicRequest,
  MusicResult,
  MusicSessionInput,
  WeightedPrompt,
} from "../domain/Music.js"

export type MusicGeneratorService = {
  /**
   * One-shot. Prompt in, full audio bytes out. Universally supported.
   * Async/poll-based providers (Suno, Mureka) hide their poll loop
   * inside the adapter — caller still sees a single `Effect`.
   */
  readonly generate: (
    request: CommonGenerateMusicRequest,
  ) => Effect.Effect<MusicResult, AiError.AiError>
  /**
   * Prompt in, audio chunks streamed out. Providers without a native
   * chunked-output endpoint (Lyria 3 sync, Mureka, MiniMax, Stable
   * Audio) emulate this by calling `generate` and emitting a single
   * `AudioChunk` — first-class, no `Unsupported`.
   */
  readonly streamGeneration: (
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  /**
   * Bidirectional session: a `Stream` of prompt-or-config updates flows
   * in, a `Stream` of audio chunks flows out. The session WS / RPC is
   * acquired on first pull and released when the output stream is
   * finalized via `Stream.scoped`.
   *
   * Gated by the `MusicInteractiveSession` capability marker on the
   * top-level helper — providers without bidirectional support don't
   * ship the marker, so calls fail at `Effect.provide` with a type
   * error.
   */
  readonly streamGenerationFrom: <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R>
}

export class MusicGenerator extends Context.Service<MusicGenerator, MusicGeneratorService>()(
  "@betalyra/effect-uai/MusicGenerator",
) {}

/**
 * Capability marker — provided by provider layers whose
 * `streamGenerationFrom` is wired up at the wire level. Currently only
 * Lyria RealTime (via the BidiGenerateMusic WebSocket) ships it.
 * Calling `streamGenerationFrom` while only a non-interactive Layer is
 * in scope fails at `Effect.provide` with a type error.
 *
 * Phantom — the value is `void`; providers register with
 * `Layer.succeed(MusicInteractiveSession, undefined)`.
 */
export class MusicInteractiveSession extends Context.Service<MusicInteractiveSession, void>()(
  "@betalyra/effect-uai/capability/MusicInteractiveSession",
) {}

/** One-shot generation. */
export const generate = (
  request: CommonGenerateMusicRequest,
): Effect.Effect<MusicResult, AiError.AiError, MusicGenerator> =>
  Effect.flatMap(MusicGenerator.asEffect(), (s) => s.generate(request))

/** Prompt in, audio chunks out. */
export const streamGeneration = (
  request: CommonStreamGenerateMusicRequest,
): Stream.Stream<AudioChunk, AiError.AiError, MusicGenerator> =>
  Stream.unwrap(Effect.map(MusicGenerator.asEffect(), (s) => s.streamGeneration(request)))

/**
 * Bidirectional generation. Dual-arity: pipeable (data-last) and
 * direct (data-first). Requires `MusicInteractiveSession` in R —
 * providers without bidirectional support are a type error at provide
 * time.
 *
 * @example
 * ```ts
 * const audio = Stream.fromIterable([
 *   Music.promptsInput([{ text: "minimal techno", weight: 1.0 }]),
 *   Music.configInput({ bpm: 124 }),
 * ]).pipe(
 *   MusicGenerator.streamGenerationFrom({ model: "lyria-realtime-001", prompts: "" }),
 * )
 * ```
 */
export const streamGenerationFrom: {
  (
    request: CommonStreamGenerateMusicRequest,
  ): <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
  ) => Stream.Stream<
    AudioChunk,
    AiError.AiError | E,
    R | MusicGenerator | MusicInteractiveSession
  >
  <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ): Stream.Stream<
    AudioChunk,
    AiError.AiError | E,
    R | MusicGenerator | MusicInteractiveSession
  >
} = Function.dual(
  2,
  <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const s = yield* MusicGenerator.asEffect()
        yield* MusicInteractiveSession.asEffect()
        return s.streamGenerationFrom(input, request)
      }),
    ),
)
