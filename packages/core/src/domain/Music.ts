import type { Duration } from "effect"
import type { AudioBlob, AudioChunk, AudioFormat } from "./Audio.js"

/**
 * Prompt fragment with a relative weight. Native to Lyria RealTime
 * (`{ text, weight }` pairs blended in the model) and Riffusion compose.
 * Single-prompt providers (the majority) treat a 1-element array with
 * `weight: 1` as a plain prompt.
 */
export type WeightedPrompt = {
  readonly text: string
  /** Default `1.0`. Range typically `[0, 1]`; provider-dependent. */
  readonly weight?: number
}

/**
 * Cross-provider music-generation request. Trimmed to fields the
 * majority of music providers honor structurally; provider-specific
 * extras (Lyria `bpm` / `scale`, ElevenLabs `compositionPlan` /
 * `signWithC2pa`, Suno `style` / `personaId`, MiniMax `lyricsOptimizer`,
 * `instrumental` on providers that ship a wire toggle) live on each
 * provider's typed request which extends this and narrows `model`.
 *
 * Music providers are one-shot text-to-audio, not conversational. No
 * `messages[]` shape applies.
 */
export type CommonGenerateMusicRequest = {
  /** Model identifier. Each provider narrows. */
  readonly model: string
  /** Single prompt string. Weighted blends are provider-typed extras. */
  readonly prompt: string
  /**
   * Lyrics text, optionally with section tags like `[Verse]` /
   * `[Chorus]` / `[Bridge]` / `[Outro]`. Routed to a structured wire
   * field on providers that have one (ElevenLabs `lines`, MiniMax
   * `lyrics`, Mureka `lyrics`, Suno custom-mode `prompt`); embedded in
   * the prompt with a warning on providers without one (Lyria 3,
   * Riffusion).
   */
  readonly lyrics?: string
  /** Target duration. Provider may treat as a hint or hard limit. */
  readonly duration?: Duration.Duration
  /**
   * Reproducibility seed. Tuning hint (bucket 3): honored where the
   * provider takes one (Lyria 2 Vertex, Lyria RealTime, ElevenLabs
   * with `compositionPlan`, Stable Audio, MusicGen); silently ignored
   * elsewhere.
   */
  readonly seed?: number
  /** Preferred output format. Provider may override. */
  readonly outputFormat?: AudioFormat
}

/**
 * Streamed-output request. Same shape as the sync request: the
 * streaming variant only differs in how the response is delivered.
 */
export type CommonStreamGenerateMusicRequest = CommonGenerateMusicRequest

/**
 * Playback-control vocabulary that converges across interactive-media
 * protocols (Web Audio, MIDI sequencer control, music SDK surfaces).
 * Provider-specific control actions (Lyria's `reset_context` and any
 * future provider's extras) live on the provider-typed session-input
 * union.
 */
export type MusicSessionControl = "play" | "pause" | "stop" | "reset"

/**
 * Bidirectional-session input on the cross-provider surface. Two
 * load-bearing actions every interactive music session needs:
 *
 * - `prompts` — steer the active generation with a (single or
 *   weighted) prompt blend.
 * - `control` — play / pause / stop / reset.
 *
 * Provider-typed services extend this union with their own `config`
 * variant for model-specific knobs (Lyria RealTime exposes density /
 * brightness / mute-stems / BPM / scale / etc. via its own
 * `LyriaRealtimeSessionInput`).
 */
export type MusicSessionInput =
  | { readonly _tag: "prompts"; readonly prompts: ReadonlyArray<WeightedPrompt> }
  | { readonly _tag: "control"; readonly action: MusicSessionControl }

export const promptsInput = (prompts: ReadonlyArray<WeightedPrompt>): MusicSessionInput => ({
  _tag: "prompts",
  prompts,
})

export const controlInput = (action: MusicSessionControl): MusicSessionInput => ({
  _tag: "control",
  action,
})

/**
 * Watermark kind on the response. SynthID is mandatory on Lyria; C2PA
 * is opt-in on ElevenLabs. No provider exposes additional metadata
 * about the watermark itself, so a bare literal-union is enough.
 */
export type Watermark = "synthid" | "c2pa" | (string & {})

/**
 * Labelled section with absolute timing. Populated when the provider
 * returns structured section metadata (Lyria text part, ElevenLabs
 * `/v1/music/detailed` with `with_timestamps`).
 */
export type MusicSection = {
  readonly label: string
  readonly startSeconds: number
  readonly endSeconds: number
}

/**
 * Single generated track. Composes `AudioBlob` rather than extending
 * it — `result.audio` is the raw blob, `result.songId` / `lyrics` /
 * `sections` / `watermark` are provider-side metadata when returned.
 */
export type MusicResult = {
  readonly audio: AudioBlob
  /**
   * Provider identifier, useful when routing through multiple
   * providers in a single pipeline (`"lyria"`, `"elevenlabs-music"`,
   * etc.).
   */
  readonly provider?: string
  /** Provider-side ID for back-reference (re-download, extension, stems). */
  readonly songId?: string
  /** Generated or transcribed lyrics when the provider returned them. */
  readonly lyrics?: string
  /** Structured section markers when the provider returned them. */
  readonly sections?: ReadonlyArray<MusicSection>
  /** Watermark presence indicator when the provider applied one. */
  readonly watermark?: Watermark
}

/**
 * Result of a `generate` call. Suno and Mureka always return 2 tracks
 * per request; every other provider returns 1. `primary` is the
 * caller-friendly convenience; `variants` carries every track the
 * provider produced (length ≥ 1; `primary === variants[0]`).
 */
export type GenerateResult = {
  readonly primary: MusicResult
  readonly variants: ReadonlyArray<MusicResult>
}

/**
 * In-band event on the bidirectional `streamGenerationFrom` output
 * stream. Audio chunks flow as `audio`; server-side warnings
 * (`warning`) and prompt-filter rejections (`filteredPrompt`) flow
 * alongside rather than going to a side-channel log.
 */
export type MusicStreamEvent =
  | { readonly _tag: "audio"; readonly chunk: AudioChunk }
  | { readonly _tag: "warning"; readonly message: string }
  | { readonly _tag: "filteredPrompt"; readonly prompt: string; readonly reason: string }

export const isPromptsInput = (
  i: MusicSessionInput,
): i is MusicSessionInput & { _tag: "prompts" } => i._tag === "prompts"
export const isControlInput = (
  i: MusicSessionInput,
): i is MusicSessionInput & { _tag: "control" } => i._tag === "control"

export const audioEvent = (chunk: AudioChunk): MusicStreamEvent => ({ _tag: "audio", chunk })
export const warningEvent = (message: string): MusicStreamEvent => ({
  _tag: "warning",
  message,
})
export const filteredPromptEvent = (prompt: string, reason: string): MusicStreamEvent => ({
  _tag: "filteredPrompt",
  prompt,
  reason,
})

export const isAudioEvent = (e: MusicStreamEvent): e is MusicStreamEvent & { _tag: "audio" } =>
  e._tag === "audio"
export const isWarningEvent = (
  e: MusicStreamEvent,
): e is MusicStreamEvent & { _tag: "warning" } => e._tag === "warning"
export const isFilteredPromptEvent = (
  e: MusicStreamEvent,
): e is MusicStreamEvent & { _tag: "filteredPrompt" } => e._tag === "filteredPrompt"

/**
 * Build a single-variant `GenerateResult` from a `MusicResult`.
 * Convenience for providers that always return exactly one track
 * (Lyria, ElevenLabs, MiniMax, Stable Audio, MusicGen, Riffusion,
 * Tencent). Providers that return multiple tracks (Suno, Mureka)
 * construct the `GenerateResult` directly.
 */
export const singleVariant = (result: MusicResult): GenerateResult => ({
  primary: result,
  variants: [result],
})
