/**
 * Generate a short clip with Lyria 3 (Google Gemini API). The recipe
 * stays runtime-agnostic — it returns Effects that read a `MusicGenerator`
 * from context. `run-node.ts` wires the real `@effect-uai/google` Layer;
 * `index.test.ts` swaps in a `MockMusicGenerator` Layer.
 *
 * Two flavours are shown:
 *
 * - `generateSimple` — single text prompt.
 * - `generateWeighted` — blended weighted prompts plus structured hints
 *   (bpm / scale / lyrics with `[Verse]` / `[Chorus]` section tags).
 *
 * `runSimple` and `runWeighted` accept user-supplied input, so the Node
 * runner can dispatch on a CLI-provided `.txt` (simple) or `.json`
 * (weighted) file.
 */
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"
import type {
  CommonGenerateMusicRequest,
  WeightedPrompt,
} from "@effect-uai/core/Music"

/**
 * JSON shape accepted by `.json` config files for the weighted variant.
 * Everything except the `prompts` blend is optional; the adapter defaults
 * the model to `lyria-3-clip-preview` and the format to mp3.
 */
export type WeightedConfig = {
  readonly prompts: ReadonlyArray<WeightedPrompt>
  readonly lyrics?: string
  readonly bpm?: number
  readonly scale?: string
  readonly durationSeconds?: number
  readonly instrumental?: boolean
  readonly model?: CommonGenerateMusicRequest["model"]
}

/** Built-in default prompt for the simple variant. */
export const defaultSimplePrompt =
  "upbeat indie pop with prominent synths and a driving 4-on-the-floor beat"

/** Built-in default config for the weighted variant. */
export const defaultWeightedConfig: WeightedConfig = {
  prompts: [
    { text: "1980s synthwave", weight: 1.0 },
    { text: "John Carpenter movie OST", weight: 0.4 },
  ],
  bpm: 100,
  scale: "A_MINOR",
  lyrics: "[Verse]\nNeon city, midnight drive\n[Chorus]\nKeep the dream alive",
}

/** Run the simple (single-prompt) variant with arbitrary prompt text. */
export const runSimple = (prompt: string) =>
  MusicGenerator.generate({
    model: "lyria-3-clip-preview",
    prompts: prompt,
    outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
  })

/** Run the weighted variant with a parsed `WeightedConfig`. */
export const runWeighted = (config: WeightedConfig) =>
  MusicGenerator.generate({
    model: config.model ?? "lyria-3-clip-preview",
    prompts: config.prompts,
    outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
    ...(config.lyrics !== undefined && { lyrics: config.lyrics }),
    ...(config.bpm !== undefined && { bpm: config.bpm }),
    ...(config.scale !== undefined && { scale: config.scale }),
    ...(config.durationSeconds !== undefined && { durationSeconds: config.durationSeconds }),
    ...(config.instrumental !== undefined && { instrumental: config.instrumental }),
  })

/** Convenience: the simple variant pre-bound to the built-in default prompt. */
export const generateSimple = runSimple(defaultSimplePrompt)

/** Convenience: the weighted variant pre-bound to the built-in default config. */
export const generateWeighted = runWeighted(defaultWeightedConfig)
