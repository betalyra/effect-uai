---
name: effect-uai-streaming-transcription
description: Use when the user wants live speech-to-text with effect-uai — browser microphone captions, voice search, realtime STT, partial/final transcript events, or streaming audio frames over WebSocket. Covers Transcriber.streamTranscriptionFrom, SttStreaming capability markers, provider sample-rate config, and OpenAI Realtime / ElevenLabs / Inworld streaming layers.
license: MIT
---

# effect-uai streaming-transcription

Live audio frames in, transcript events out. Use
`Transcriber.streamTranscriptionFrom` when the user should see text
while they are still speaking.

Reach for this when the user says any of:

- "Build live captions / realtime transcription"
- "Stream browser mic audio to STT"
- "Show partial transcripts and commit finals"

## Pattern

```ts
import { Stream } from "effect"
import * as Transcriber from "@effect-uai/core/Transcriber"

export const transcribeMicStream = (audioIn: Stream.Stream<Uint8Array>) =>
  audioIn.pipe(
    Transcriber.streamTranscriptionFrom({
      model: "scribe_v2_realtime",
      inputFormat: {
        container: "raw",
        encoding: "pcm_s16le",
        sampleRate: 16000,
        channels: 1,
      },
      interimResults: true,
    }),
  )
```

Output is a `Stream<TranscriptEvent>`:

- `partial` is speculative UI text.
- `final` is committed text; append it to logs, search, commands, or an
  LLM prompt.
- `speech-started` / `utterance-ended` are provider-dependent VAD
  events.

## Capability marker

`streamTranscriptionFrom` requires the generic `Transcriber` tag plus
`SttStreaming`. Providers that only support sync STT do not register
the marker, so the wrong Layer fails at `Effect.provide`.

Streaming providers today:

- OpenAI Realtime: raw PCM s16le mono at 24 kHz.
- ElevenLabs Scribe v2 Realtime: raw PCM s16le mono at 16 kHz.
- Inworld realtime: raw PCM s16le mono at 16 kHz.

Gemini transcription is sync-only; use `effect-uai-basic-transcription`
for that path.

## Browser bridge

Keep the browser as a mic adapter:

```text
getUserMedia -> AudioWorklet -> WebSocket -> Stream<Uint8Array>
```

The server owns the Effect Layer and provider WebSocket. Fetch provider
config (`sampleRate`, `channels`, encoding) before recording so the
worklet sends the right format.

## Anti-patterns

- **Don't append partials as committed transcript.** Partials can be
  revised; only `final` is stable.
- **Don't hide sample-rate conversion in the provider call.** Send the
  provider's expected `inputFormat`.
- **Don't use sync-only providers in a live pipeline.** Let the
  `SttStreaming` marker enforce that.

## See also

- Recipe source: `recipes/streaming-transcription/index.ts`
- For finished files: `effect-uai-basic-transcription`
- For STT -> LLM -> TTS: `effect-uai-voice-loop`
