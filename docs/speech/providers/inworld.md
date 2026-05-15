---
title: Inworld
description: First-party STT/TTS plus router-style passthroughs to AssemblyAI / Soniox / Groq Whisper under one Inworld key.
---

Inworld covers the full speech surface — sync + streaming in both
directions, both capability markers shipped — and adds router-style
passthroughs that proxy to other STT providers (AssemblyAI, Soniox,
Groq Whisper) under the same Inworld auth and billing.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/inworld effect
```

## Layers

| Layer | Registers | Capability markers |
| --- | --- | --- |
| `@effect-uai/inworld/InworldTranscriber` | `InworldTranscriber` + `Transcriber` | — (sync) |
| `@effect-uai/inworld/InworldRealtimeTranscriber` | `InworldRealtimeTranscriber` + `Transcriber` | `SttStreaming` |
| `@effect-uai/inworld/InworldSynthesizer` | `InworldSynthesizer` + `SpeechSynthesizer` | — (sync + chunked NDJSON) |
| `@effect-uai/inworld/InworldRealtimeSynthesizer` | `InworldRealtimeSynthesizer` + `SpeechSynthesizer` | `TtsIncrementalText` |

The sync and realtime layers are separate so you can pull only what
you need — the realtime paths add WS / JWT plumbing.

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { layer as realtimeTranscriber } from "@effect-uai/inworld/InworldRealtimeTranscriber"
import { layer as realtimeSynth } from "@effect-uai/inworld/InworldRealtimeSynthesizer"

const inworld = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("INWORLD_API_KEY")
    return Layer.mergeAll(realtimeTranscriber({ apiKey }), realtimeSynth({ apiKey }))
  }),
)

const mainLayer = inworld.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
)
```

## Models

### STT

| Model | Native | Streaming WS |
| --- | --- | --- |
| `inworld/inworld-stt-1` | First-party (experimental) | ✓ |
| `assemblyai/universal-streaming-english` | AssemblyAI passthrough | ✓ |
| `assemblyai/universal-streaming-multilingual` | AssemblyAI | ✓ |
| `assemblyai/u3-rt-pro` | AssemblyAI | ✓ |
| `assemblyai/whisper-rt` | AssemblyAI | ✓ |
| `soniox/stt-rt-v4` | Soniox | ✓ |
| `groq/whisper-large-v3` | Groq | — (sync only) |

Passthrough models are billed against your Inworld key — no separate
contracts. Sync STT works for all; streaming WS is supported by
everything except `groq/whisper-large-v3`.

### TTS

| Model | Latency (P50) | Languages | Notes |
| --- | --- | --- | --- |
| `inworld-tts-2` | ~200 ms | 100+ | Flagship; honors `deliveryMode` |
| `inworld-tts-1.5-max` | ~200 ms | 15 | |
| `inworld-tts-1.5-mini` | ~120 ms | 15 | Lowest latency |

Voice IDs are human-readable names ("Sarah", "Edward", …) but Inworld
doesn't publish a list-voices REST endpoint — browse via the Inworld
Portal. `InworldVoiceId` is typed as plain `string`.

## Request shape

```ts
// TTS sync + streaming
type InworldSynthesizeRequest = {
  readonly model: InworldTtsModel
  readonly voiceId: InworldVoiceId
  readonly text: string // omitted on streamSynthesisFrom
  readonly outputFormat?: AudioFormat
  readonly speed?: number
  readonly temperature?: number // (0, 2]
  readonly deliveryMode?: "STABLE" | "BALANCED" | "CREATIVE" // tts-2 only
  readonly applyTextNormalization?: "ON" | "OFF" // default "ON"
}
```

`deliveryMode` is the style-steering knob on `inworld-tts-2`:
`STABLE` for consistent reading-voice output, `CREATIVE` for more
expressive prosody. Older models ignore it silently.

`applyTextNormalization: "OFF"` skips the server-side text rewriter
(expanding numbers, abbreviations, etc.) — faster, but punctuation
pacing is on you.

## Wire / auth notes

- **Sync** endpoints: REST with bearer auth via `Authorization` header.
  Sync TTS comes back as either a single base64 audio blob
  (`/tts/v1/voice`) or NDJSON one chunk per line
  (`/tts/v1/voice:stream`).
- **Realtime** endpoints: short-lived JWT minted from the API key
  (`wsAuth.ts`), passed as a bearer on the WS upgrade. Realtime STT
  expects PCM s16le at 16 kHz mono.

Audio encoding options for TTS (`audioConfig.audioEncoding`):
`LINEAR16`, `MP3`, `OGG_OPUS`, `ALAW`, `MULAW`, `FLAC`, `PCM`, `WAV`.
**Caveat**: sync `LINEAR16` / `WAV` responses include a WAV header;
streaming chunks **don't**. The codec layer surfaces this via
`AudioFormat.container` (`"wav"` vs `"raw"`).

## Errors

Standard HTTP → `AiError` mapping. WS-side failures surface on the
stream's error channel; non-fatal mid-stream errors come through as
`TranscriptEvent`s with `_tag: "error"`.

## See also

- [Speech overview](/speech/) — capability markers and provider matrix.
- [Streaming transcription](/recipes/streaming-transcription/) — Inworld
  can be slotted in as a third provider via the recipe's `--provider`
  argument pattern.
