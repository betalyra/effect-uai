---
title: ElevenLabs
description: ElevenLabs Transcriber (Scribe v2 Realtime) and Synthesizer (Flash v2.5) — the full streaming surface, both capability markers shipped.
---

ElevenLabs is the most complete speech surface today: streaming STT
over WebSocket, streaming TTS with both chunked-HTTP and
incremental-text-in WS, voice cloning supported by ID, all
browser-friendly (no special peer deps).

## Install

```sh
pnpm add @effect-uai/core @effect-uai/elevenlabs effect
```

## Layers

| Layer                                          | Registers                                     | Capability markers   |
| ---------------------------------------------- | --------------------------------------------- | -------------------- |
| `@effect-uai/elevenlabs/ElevenLabsTranscriber` | `ElevenLabsTranscriber` + `Transcriber`       | `SttStreaming`       |
| `@effect-uai/elevenlabs/ElevenLabsSynthesizer` | `ElevenLabsSynthesizer` + `SpeechSynthesizer` | `TtsIncrementalText` |

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { layer as transcriberLayer } from "@effect-uai/elevenlabs/ElevenLabsTranscriber"
import { layer as synthLayer } from "@effect-uai/elevenlabs/ElevenLabsSynthesizer"

const eleven = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY")
    return Layer.mergeAll(transcriberLayer({ apiKey }), synthLayer({ apiKey }))
  }),
)

const mainLayer = eleven.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
)
```

The synthesizer's `streamSynthesisFrom` (incremental text-in) requires
a `WebSocketConstructor` — `Socket.layerWebSocketConstructorGlobal`
binds `globalThis.WebSocket`, which works in Bun, Node 22+, and
browsers.

## Models

### STT

| Model                | Streaming | Notes                                                     |
| -------------------- | --------- | --------------------------------------------------------- |
| `scribe_v2_realtime` | ✓ (WS)    | The realtime variant — used by `streamTranscriptionFrom`  |
| `scribe_v2`          | —         | Sync variant; not exposed as a separate sync helper today |
| `scribe_v1`          | —         | Legacy                                                    |

`@effect-uai/elevenlabs/ElevenLabsTranscriber` registers
`SttStreaming` and is the realtime path; sync transcription via the
ElevenLabs REST endpoint isn't wired up yet — for sync STT today,
reach for `OpenAITranscriber` or `InworldTranscriber`.

### TTS

| Model                    | Streaming | Incremental-text-in | Notes                                                                                |
| ------------------------ | --------- | ------------------- | ------------------------------------------------------------------------------------ |
| `eleven_flash_v2_5`      | ✓         | ✓                   | **Sub-100 ms first-byte. Default for the voice-loop recipe.**                        |
| `eleven_turbo_v2_5`      | ✓         | ✓                   | Low latency, 32 languages                                                            |
| `eleven_multilingual_v2` | ✓         | ✓                   | Production-grade multilingual (29 languages)                                         |
| `eleven_v3`              | ✓         | ✓                   | Most expressive; inline audio-tag emotion (`<laugh>`, `<whisper>`, …); 70+ languages |

Voice IDs are 20-character opaque slugs (e.g. `JBFqnCBsd6RMkjVDRZzb`).
Same shape for stock and cloned voices — `ElevenLabsVoiceId` is just
`string`. Browse the catalog via the ElevenLabs portal or
`GET /v1/voices`.

## Request shape

```ts
// STT streaming
type ElevenLabsStreamTranscribeRequest = {
  readonly model: ElevenLabsSttModel // typically "scribe_v2_realtime"
  readonly inputFormat: AudioFormat // 16 kHz pcm s16le mono
  readonly language?: string
  readonly interimResults?: boolean
  readonly vadEvents?: boolean
  readonly diarization?: boolean
}

// TTS sync + chunked + incremental
type ElevenLabsSynthesizeRequest = {
  readonly model: ElevenLabsTtsModel
  readonly voiceId: ElevenLabsVoiceId
  readonly text: string // omitted on streamSynthesisFrom
  readonly outputFormat?: AudioFormat
  readonly voiceSettings?: VoiceSettings // stability, similarity_boost, style, use_speaker_boost
  readonly seed?: number // deterministic generation
  readonly previousText?: string // prosody context
  readonly nextText?: string
  readonly pronunciationDictionaryLocators?: ReadonlyArray<PronunciationDictionaryLocator>
}

type PronunciationDictionaryLocator = {
  readonly dictionaryId: string
  readonly versionId: string
}
```

ElevenLabs has no stateless inline IPA path, so inline `pronunciations`
on the common request fail with `AiError.Unsupported`. For phoneme
control, provision a pronunciation dictionary (dashboard or the
pronunciation-dictionary API) and reference it by id via
`pronunciationDictionaryLocators`.

`voiceSettings` exposes ElevenLabs' prosody controls:

```ts
type VoiceSettings = {
  readonly stability?: number // 0..1 — higher = more consistent
  readonly similarityBoost?: number // 0..1 — clone fidelity
  readonly style?: number // 0..1 — emotion intensity (v3+)
  readonly useSpeakerBoost?: boolean
}
```

`previousText` / `nextText` thread context across sequential synthesis
calls so prosody flows naturally between chunks — useful when you're
synthesizing one paragraph at a time.

## Wire / auth notes

**Realtime STT** mints a single-use token via REST
(`POST /v1/single-use-token/realtime_scribe`) and carries it as a
`?token=…` query param on the WS upgrade. No headers needed → works
from the browser directly with `globalThis.WebSocket`. Expects PCM
s16le at **16 kHz** mono.

**Realtime TTS** (`/stream-input`) takes incoming text as JSON frames
on a single WS, returns base64 PCM audio frames. The provider closes
with code `1000` on a clean end — the adapter whitelists
`1000` / `1001` / `1005` via `closeCodeIsError` so a graceful close
doesn't surface as a stream failure.

**Output formats**: PCM s16le at 16 / 22.05 / 24 / 44.1 kHz, plus MP3 at
several bitrates and µ-law / A-law for telephony. PCM at 24 kHz is the
sweet spot for browser `AudioWorklet` playback.

## Errors

Standard HTTP → `AiError` mapping. Non-fatal mid-stream errors arrive
as `TranscriptEvent`s with `_tag: "error"` and don't end the stream;
fatal failures surface on the `Stream`'s error channel.

## See also

- [Voice loop](/recipes/voice-loop/) — **default provider**;
  Scribe v2 Realtime + Flash v2.5 + Gemini 2.5 Flash.
- [Streaming synthesis](/recipes/streaming-synthesis/) — incremental
  text-in over WS.
- [Streaming transcription](/recipes/streaming-transcription/) —
  selectable via `--provider elevenlabs`.
