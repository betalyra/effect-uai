---
title: OpenAI
description: OpenAI Transcriber (sync + realtime) and Synthesizer — typed options, layer wiring, supported models.
---

OpenAI ships sync transcription via REST, realtime transcription via
WebSocket, and text-to-speech via chunked HTTP. Each lives at its own
subpath so the realtime peer dep doesn't infect sync-only builds.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/openai effect
```

The realtime transcriber additionally needs `ws` (a peer dep):

```sh
pnpm add ws
```

`ws` is only pulled in by `@effect-uai/openai/OpenAIRealtimeTranscriber`.
The sync `OpenAITranscriber` and `OpenAISynthesizer` paths don't
require it — edge / browser builds stay slim.

## Layers

| Layer                                          | Registers                                   | Capability markers                                                   |
| ---------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `@effect-uai/openai/OpenAITranscriber`         | `OpenAITranscriber` + `Transcriber`         | —                                                                    |
| `@effect-uai/openai/OpenAIRealtimeTranscriber` | `OpenAIRealtimeTranscriber` + `Transcriber` | `SttStreaming`                                                       |
| `@effect-uai/openai/OpenAISynthesizer`         | `OpenAISynthesizer` + `SpeechSynthesizer`   | — (no `TtsIncrementalText` — OpenAI has no `/stream-input` endpoint) |

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as transcriberLayer } from "@effect-uai/openai/OpenAITranscriber"
import { layer as realtimeLayer } from "@effect-uai/openai/OpenAIRealtimeTranscriber"
import { layer as synthLayer } from "@effect-uai/openai/OpenAISynthesizer"

const openai = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return Layer.mergeAll(
      transcriberLayer({ apiKey }), // sync STT
      realtimeLayer({ apiKey }), // streaming STT
      synthLayer({ apiKey }), // sync + chunked TTS
    )
  }),
)

const mainLayer = openai.pipe(Layer.provide(FetchHttpClient.layer))
```

## Models

### STT

| Model                    | Sync | Streaming                   | Notes                                            |
| ------------------------ | ---- | --------------------------- | ------------------------------------------------ |
| `gpt-4o-transcribe`      | ✓    | ✓ (`?intent=transcription`) | Plain text only                                  |
| `gpt-4o-mini-transcribe` | ✓    | ✓                           | Plain text only, cheaper                         |
| `whisper-1`              | ✓    | —                           | **Only model supporting `wordTimestamps: true`** |

`wordTimestamps: true` requires `whisper-1`. Passing it to a GPT-4o
model surfaces the provider's wire rejection (HTTP 400) rather than a
pre-send error. `diarization` is narrowed off `OpenAITranscribeRequest`
(OpenAI's transcription endpoint has none).

### TTS

| Model                | Streaming    | Notes                                          |
| -------------------- | ------------ | ---------------------------------------------- |
| `gpt-4o-mini-tts`    | chunked HTTP | Current steerable model; honors `instructions` |
| `tts-1` / `tts-1-hd` | chunked HTTP | Legacy; ignore `instructions` silently         |

Stock voices (no custom-voice path): `alloy`, `ash`, `ballad`, `coral`,
`echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, `verse`. `ballad`,
`coral`, and `verse` are `gpt-4o-mini-tts`-only. Because there's no
clone path, `OpenAISynthesizeRequest.voiceId` narrows to the
stock-only literal union — passing an arbitrary string is a type
error.

## Request shape

```ts
// STT sync
type OpenAITranscribeRequest = {
  readonly model: OpenAITranscribeModel
  readonly audio: AudioSource
  readonly language?: string
  readonly prompt?: string // free-form prose context, mapped to OpenAI's prompt
  readonly biasingTerms?: ReadonlyArray<string> // warnDropped (no keyterm field)
  readonly wordTimestamps?: boolean // whisper-1 only
  readonly temperature?: number
  readonly fileName?: string // overrides multipart filename
}

// TTS sync + chunked
type OpenAISynthesizeRequest = {
  readonly model: OpenAITtsModel
  readonly voiceId: OpenAIVoiceId // stock-only literal union
  readonly text: string
  readonly outputFormat?: AudioFormat
  readonly speed?: number
  readonly instructions?: string // gpt-4o-mini-tts only
}
```

`instructions` is a free-form prompt for tone, emotion, pacing —
"sound apologetic," "read this slowly with emphasis on the second
sentence." Honored only by `gpt-4o-mini-tts`; silently ignored by
the legacy `tts-1` family.

## Wire / auth notes

**Realtime STT** uses
`wss://api.openai.com/v1/realtime?intent=transcription` and requires
two upgrade headers: `Authorization: Bearer …` and
`OpenAI-Beta: realtime=v1`. Browser `WebSocket` can't set headers, so
`OpenAIRealtimeTranscriber` uses the `ws` peer dep to construct the
socket with those headers — that's why this transcriber lives at a
separate subpath. Use it from Node / Bun; for browser deployments,
proxy through a server.

Realtime expects PCM s16le at **24 kHz** (not 16 like most other
providers). Set `inputFormat` accordingly on the streaming request,
or the upstream rejects the audio.

**Output formats** for TTS: `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`.
`pcm` is 24 kHz mono s16le, suitable for direct `AudioWorklet`
playback.

## Errors

Standard HTTP → `AiError` mapping applies:

| Status      | Error                         |
| ----------- | ----------------------------- |
| `429`       | `AiError.RateLimited`         |
| `408`/`504` | `AiError.Timeout`             |
| `401`       | `AiError.AuthFailed` (`auth`) |
| `>= 500`    | `AiError.Unavailable`         |
| other 4xx   | `AiError.InvalidRequest`      |

`wordTimestamps: true` against a non-`whisper-1` model →
`AiError.Unsupported` at request time.

## See also

- [Speech overview](/speech/) — generic tags and capability markers.
- [Voice loop](/recipes/voice-loop/) — uses ElevenLabs by default;
  the recipe's `runPipeline` typechecks against either provider via
  the marker contract.
- [Streaming transcription](/recipes/streaming-transcription/) —
  default provider is OpenAI Realtime.
