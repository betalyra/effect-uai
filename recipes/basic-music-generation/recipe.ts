/**
 * Generate a short clip via the generic `MusicGenerator` service. The
 * recipe body stays provider-agnostic: it returns Effects that read a
 * `MusicGenerator` from context. `run-node.ts` dispatches between
 * `@effect-uai/google/LyriaGenerator` and
 * `@effect-uai/elevenlabs/ElevenLabsMusicGenerator` via the
 * `--provider=` flag. `index.test.ts` swaps in a `MockMusicGenerator`
 * Layer.
 *
 * Only Common-request fields appear here. Provider-specific extras
 * (Lyria's prompt-only structure tags, ElevenLabs's `compositionPlan`
 * / `forceInstrumental` / `signWithC2pa`) live on each provider's
 * typed service if you need them.
 */
import { Duration } from "effect"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"

/** Built-in default prompt. Plain text, no client-side construction. */
export const defaultPrompt =
  "upbeat indie pop with prominent synths and a driving 4-on-the-floor beat"

/**
 * Per-provider default model. The Common request takes a `model`
 * string; the runner resolves a sensible default per `--provider=`
 * value before constructing the request.
 */
export type Provider = "google" | "elevenlabs"

export const defaultModel: Record<Provider, string> = {
  google: "lyria-3-clip-preview",
  elevenlabs: "music_v1",
}

/**
 * Run a generation against whatever `MusicGenerator` is in scope. The
 * Lyria Layer (`@effect-uai/google/LyriaGenerator`) is fixed at 30 s
 * for the clip model and ignores `duration`; ElevenLabs honors it.
 */
export const run = (input: { readonly model: string; readonly prompt: string }) =>
  MusicGenerator.generate({
    model: input.model,
    prompt: input.prompt,
    duration: Duration.seconds(30),
    outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
  })

/**
 * Convenience: the default prompt + the provider-default model.
 */
export const runDefault = (provider: Provider) =>
  run({ model: defaultModel[provider], prompt: defaultPrompt })
