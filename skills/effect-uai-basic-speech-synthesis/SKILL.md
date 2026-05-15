---
name: effect-uai-basic-speech-synthesis
description: Use when the user wants text-to-speech with effect-uai from finished text — read aloud, generate audio files, notification readers, podcast snippets, or chunked TTS playback. Covers SpeechSynthesizer.synthesize, SpeechSynthesizer.streamSynthesis, AudioBlob / AudioChunk results, provider voice IDs, and OpenAI / Gemini / ElevenLabs / Inworld layers.
license: MIT
---

# effect-uai basic-speech-synthesis

Finished text in, audio out. Use `synthesize` when you want a complete
file, and `streamSynthesis` when playback can start as chunks arrive.

Reach for this when the user says any of:

- "Turn this text into speech / audio"
- "Generate an mp3/wav from text"
- "Stream TTS chunks for finished text"

## One-shot

```ts
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

export const synthesizeOneShot = SpeechSynthesizer.synthesize({
  text: "Hello from effect-uai.",
  model: "gpt-4o-mini-tts",
  voiceId: "alloy",
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 24000 },
})
```

Returns an `AudioBlob`:

```ts
type AudioBlob = {
  readonly format: AudioFormat
  readonly bytes: Uint8Array
  readonly durationSeconds?: number
}
```

## Chunked

```ts
const chunks = SpeechSynthesizer.streamSynthesis({
  text,
  model: "eleven_multilingual_v2",
  voiceId: "JBFqnCBsd6RMkjVDRZzb",
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, bitRate: 128 },
})
```

`streamSynthesis` takes finished text and returns `Stream<AudioChunk>`.
Use it for early playback or cheap cancellation, not for LLM token
deltas. For token deltas, use `effect-uai-streaming-synthesis`.

## Provider switching

Keep model, voice, and output format near the provider Layer:

```ts
import { Match } from "effect"

export type Provider = "openai" | "gemini" | "elevenlabs" | "inworld"

const requestFor = Match.type<Provider>().pipe(
  Match.when("openai", () => ({ text, model: "gpt-4o-mini-tts", voiceId: "alloy" })),
  Match.when("gemini", () => ({ text, model: "gemini-2.5-flash-preview-tts", voiceId: "Kore" })),
  Match.when("elevenlabs", () => ({ text, model: "eleven_multilingual_v2", voiceId: "JBFqnCBsd6RMkjVDRZzb" })),
  Match.when("inworld", () => ({ text, model: "inworld-tts-2", voiceId: "Sarah" })),
  Match.exhaustive,
)
```

Provider-typed requests narrow stock voice IDs. Providers with custom
or cloned voices expose a wider `voiceId`.

## Anti-patterns

- **Don't use `streamSynthesis` for token-streaming text.** It still
  expects finished text; use `streamSynthesisFrom` for LLM deltas.
- **Don't assume output containers match across providers.** Preserve
  `blob.format` or choose `outputFormat` explicitly.
- **Don't hard-code arbitrary voice IDs against stock-only providers.**
  Use the provider-typed request when you want compile-time voice
  checking.

## See also

- Recipe source: `recipes/basic-speech-synthesis/index.ts`
- For LLM-token TTS: `effect-uai-streaming-synthesis`
- For voice assistants: `effect-uai-voice-loop`
