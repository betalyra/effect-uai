---
title: Mistral
description: Use Voxtral with effect-uai for transcription (batch + realtime) and text-to-speech with voice cloning.
---

Mistral's Voxtral family covers the whole speech surface: transcription
(one-shot and live), and text-to-speech with streaming output and
zero-shot voice cloning. It plugs into the generic `Transcriber` and
`SpeechSynthesizer` tags, so it drops straight into the
[voice loop](/recipes/voice-loop/) or any STT/TTS flow. The same package
also ships Mistral's chat [language model](/providers/mistral/).

## Install

```sh
pnpm add @effect-uai/core @effect-uai/mistral effect
```

Live transcription runs over a WebSocket and needs the `ws` peer dep
(Node / Bun):

```sh
pnpm add ws
```

Batch transcription and TTS don't need it, so edge / browser builds stay
slim.

## Layers

Pick the transcriber that matches how you feed audio, a recorded file
(batch) or a live microphone (realtime), and add the synthesizer for
speech output:

| Layer                                            | Use it for                       | Provides                                   |
| ------------------------------------------------ | -------------------------------- | ------------------------------------------ |
| `@effect-uai/mistral/MistralTranscriber`         | transcribe a finished audio file | `Transcriber`                              |
| `@effect-uai/mistral/MistralRealtimeTranscriber` | transcribe a live audio stream   | `Transcriber` + live streaming             |
| `@effect-uai/mistral/MistralSynthesizer`         | turn text into speech            | `SpeechSynthesizer` + streaming text input |

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as realtimeLayer } from "@effect-uai/mistral/MistralRealtimeTranscriber"
import { layer as synthLayer } from "@effect-uai/mistral/MistralSynthesizer"

const mistral = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("MISTRAL_API_KEY")
    return Layer.mergeAll(realtimeLayer({ apiKey }), synthLayer({ apiKey }))
  }),
)

const mainLayer = mistral.pipe(Layer.provide(FetchHttpClient.layer))
```

## Transcription

Batch transcription takes an `AudioSource` and returns the text plus
optional word timestamps and speaker labels:

```ts
type MistralTranscribeRequest = {
  readonly model: MistralTranscribeModel // "voxtral-mini-latest"
  readonly audio: AudioSource
  readonly language?: string
  readonly diarization?: boolean // label speakers
  readonly wordTimestamps?: boolean // per-word timings
  readonly biasingTerms?: ReadonlyArray<string> // boost names / jargon
}
```

Voxtral transcribes 13 languages with diarization, word timestamps, and
vocabulary biasing.

**Live transcription** (`streamTranscriptionFrom`) consumes a stream of
microphone audio (PCM s16le at 16 kHz mono) and emits partial
transcripts as you speak. Voxtral streams continuously rather than
chopping speech into turns, so the transcriber commits a **final** after
a brief pause; tune the pause with `utteranceSilence` (a `Duration`,
default 700 ms) on the layer config. That's what gives a voice assistant its
per-utterance turns.

## Text-to-speech

```ts
type MistralSynthesizeRequest = {
  readonly model: MistralTtsModel // "voxtral-mini-tts-2603"
  readonly voiceId: string // a preset voice id
  readonly refAudio?: string // base64 clip for instant voice cloning
  readonly text: string // omit when streaming text in
  readonly outputFormat?: AudioFormat
}
```

- **`synthesize`**: full text in, one audio blob out.
- **`streamSynthesis`** / **`streamSynthesisFrom`**: stream audio out as
  it's generated, the latter taking the text itself as a stream (it
  speaks one full utterance per call). Time-to-first-audio is around
  0.8 s with the `pcm` format.

**Voices.** Mistral ships preset voices; list the ones available to your
account with `GET /v1/audio/voices?type=presets` (ids look like
`gb_jane_neutral`, `us_paul_neutral`) and pass one as `voiceId`. For
zero-shot cloning, set `refAudio` to a 2-3 s base64 reference clip and it
takes over from `voiceId`.

**Output formats.** `pcm` (lowest latency, ideal for `AudioWorklet`
playback), `wav`, `mp3`, `flac`, and `opus`. Voxtral has no phoneme
controls, so inline pronunciation overrides aren't supported.

## Errors

Failures surface as typed `AiError` variants:

| Status      | Error                         |
| ----------- | ----------------------------- |
| `429`       | `AiError.RateLimited`         |
| `408`/`504` | `AiError.Timeout`             |
| `401`       | `AiError.AuthFailed` (`auth`) |
| `>= 500`    | `AiError.Unavailable`         |
| other 4xx   | `AiError.InvalidRequest`      |

Mid-stream transcription hiccups arrive as `TranscriptEvent`s tagged
`"error"` without ending the stream.

## See also

- [Voice loop](/recipes/voice-loop/): runnable end-to-end with
  `--provider mistral` (Voxtral STT + Mistral LLM + Voxtral TTS).
- [Speech overview](/speech/): the generic tags and capability markers.
- [Mistral language model](/providers/mistral/): the chat side of the
  same package.
