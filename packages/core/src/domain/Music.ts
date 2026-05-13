import type { AudioBlob, AudioFormat } from "./Audio.js"

/**
 * Prompt fragment with a relative weight. Native to Lyria RealTime
 * (`{ text, weight }` pairs blended in the model). Single-prompt
 * providers (Suno, Mureka, MiniMax) flatten to text at the adapter
 * layer.
 */
export type WeightedPrompt = {
  readonly text: string
  /** Default `1.0`. Range typically `[0, 1]`; provider-dependent. */
  readonly weight?: number
}

/**
 * Cross-provider music-generation request. Provider-specific extras
 * (Lyria `mode`, ElevenLabs `composition_plan`, Suno custom-mode `title`,
 * MiniMax `lyrics_optimizer`) live on each provider's typed request
 * which extends this and narrows `model`.
 */
export type CommonGenerateMusicRequest = {
  /** Model identifier. Each provider narrows. */
  readonly model: string
  /** Single prompt string or weighted-prompt list (blended where supported). */
  readonly prompts: string | ReadonlyArray<WeightedPrompt>
  /**
   * Lyrics text, optionally with section tags like `[Verse]` / `[Chorus]` /
   * `[Bridge]` / `[Outro]`. Ignored for instrumental-only providers or
   * when `instrumental: true`.
   */
  readonly lyrics?: string
  /** Target duration in seconds. Provider may treat as a hint or hard limit. */
  readonly durationSeconds?: number
  /** Beats per minute (60–200 typical). */
  readonly bpm?: number
  /**
   * Musical key/mode hint. Provider-specific vocabulary (e.g. Lyria
   * RealTime uses enum values like `"C_MAJOR"`, `"A_MINOR"`).
   */
  readonly scale?: string
  /** Skip vocals / lyrics. */
  readonly instrumental?: boolean
  /** Preferred output format. Provider may override. */
  readonly outputFormat?: AudioFormat
}

/**
 * Streamed-output request. Same shape as the sync request — the
 * streaming variant only differs in how the response is delivered.
 */
export type CommonStreamGenerateMusicRequest = CommonGenerateMusicRequest

/**
 * Bidirectional-session input. The user pushes one of these per
 * change: a new prompt blend, a config delta, or a playback control.
 * Lyria RealTime is the only provider currently surfacing these.
 */
export type MusicSessionInput =
  | { readonly _tag: "prompts"; readonly prompts: ReadonlyArray<WeightedPrompt> }
  | {
      readonly _tag: "config"
      readonly config: {
        readonly bpm?: number
        readonly scale?: string
        readonly density?: number
        readonly brightness?: number
        readonly guidance?: number
        readonly temperature?: number
        readonly topK?: number
        readonly seed?: number
        readonly muteBass?: boolean
        readonly muteDrums?: boolean
        readonly onlyBassAndDrums?: boolean
      }
    }
  | { readonly _tag: "control"; readonly action: "play" | "pause" | "stop" | "reset_context" }

export const promptsInput = (prompts: ReadonlyArray<WeightedPrompt>): MusicSessionInput => ({
  _tag: "prompts",
  prompts,
})

export const configInput = (
  config: (MusicSessionInput & { _tag: "config" })["config"],
): MusicSessionInput => ({ _tag: "config", config })

export const controlInput = (
  action: (MusicSessionInput & { _tag: "control" })["action"],
): MusicSessionInput => ({ _tag: "control", action })

/**
 * Sync-generation result. Extends `AudioBlob` with provider-side
 * metadata that's common across music providers:
 *
 * - `songId` — Suno task id, ElevenLabs `song_id`, etc. Used for
 *   back-reference (re-download, stem export, follow-up edits).
 * - `lyrics` — generated lyrics when the model returned them (Lyria
 *   text part, Mureka, Suno).
 * - `sections` — structured section markers (Lyria optional JSON
 *   structure response).
 * - `watermark` — presence marker (Lyria SynthID is always set).
 */
export type MusicResult = AudioBlob & {
  readonly songId?: string
  readonly lyrics?: string
  readonly sections?: ReadonlyArray<{
    readonly label: string
    readonly startSeconds: number
    readonly endSeconds: number
  }>
  readonly watermark?: { readonly kind: string }
}

export const isPromptsInput = (
  i: MusicSessionInput,
): i is MusicSessionInput & { _tag: "prompts" } => i._tag === "prompts"
export const isConfigInput = (i: MusicSessionInput): i is MusicSessionInput & { _tag: "config" } =>
  i._tag === "config"
export const isControlInput = (
  i: MusicSessionInput,
): i is MusicSessionInput & { _tag: "control" } => i._tag === "control"
