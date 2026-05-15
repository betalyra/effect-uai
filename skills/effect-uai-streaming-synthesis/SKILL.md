---
name: effect-uai-streaming-synthesis
description: Use when the user wants low-latency text-to-speech from incremental text with effect-uai — LLM token deltas to audio, spoken chat responses, browser playback from AudioChunk streams, or ElevenLabs / Inworld stream-input TTS. Covers SpeechSynthesizer.streamSynthesisFrom, TtsIncrementalText markers, raw PCM output formats, and piping Stream<string> into audio.
license: MIT
---

# effect-uai streaming-synthesis

Incremental text in, audio chunks out. Use
`SpeechSynthesizer.streamSynthesisFrom` when the text is still being
written and the user should already hear the first phrase.

Reach for this when the user says any of:

- "Read LLM output aloud as it streams"
- "Pipe token deltas into TTS"
- "Start TTS playback before the full answer exists"

## Pattern

```ts
import { Stream } from "effect"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

export const synthesizeText = (textIn: Stream.Stream<string>) =>
  textIn.pipe(
    SpeechSynthesizer.streamSynthesisFrom({
      model: "eleven_flash_v2_5",
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
      outputFormat: {
        container: "raw",
        encoding: "pcm_s16le",
        sampleRate: 48000,
        channels: 1,
      },
    }),
  )
```

Input can be typed words, model text deltas, or any `Stream<string>`.
Output is `Stream<AudioChunk>`.

## LLM pipe

```ts
const audio = LanguageModel.streamTurn({ history, model: "gemini-2.5-flash" }).pipe(
  Stream.filterMap(Turn.toTextDelta),
  SpeechSynthesizer.streamSynthesisFrom({
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    outputFormat,
  }),
)
```

Keep UI text and TTS text separate if needed. For example, apply
phonetic rewrites or strip markdown just before TTS, while showing the
original model text in the UI.

## Capability marker

`streamSynthesisFrom` requires `TtsIncrementalText`. Today that means:

- ElevenLabs `/stream-input`.
- Inworld realtime TTS.

OpenAI and Gemini synthesize finished text, but do not accept
incremental text input; use `effect-uai-basic-speech-synthesis` for
those providers.

## Browser playback

Raw PCM (`container: "raw"`, `encoding: "pcm_s16le"`) is the simplest
low-latency browser path. Forward chunks over WebSocket and schedule
them in an `AudioWorklet` or `AudioBufferSourceNode` chain.

## Anti-patterns

- **Don't buffer the whole LLM answer before TTS.** That defeats the
  point of `streamSynthesisFrom`.
- **Don't use providers without `TtsIncrementalText`.** The marker is
  the contract for incremental text input.
- **Don't mix UI text cleanup with model history.** Strip markdown or
  phoneticize for speech at the TTS boundary only.

## See also

- Recipe source: `recipes/streaming-synthesis/index.ts`
- For finished text TTS: `effect-uai-basic-speech-synthesis`
- For STT -> LLM -> TTS: `effect-uai-voice-loop`
