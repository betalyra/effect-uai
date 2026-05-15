---
title: Transcription
description: Audio in, text out — one-shot for finished files, streaming for live mics.
---

Caption a podcast, transcribe a meeting, or stream a live mic — they're
the same call with different inputs.

Use `transcribe` when the audio already exists. Use
`streamTranscriptionFrom` when audio is arriving over time and the UI
should update while the person is still speaking.

## Two Paths

```ts
import { transcribe, streamTranscriptionFrom } from "@effect-uai/core/Transcriber"

transcribe(request) // finished audio -> TranscriptResult
streamTranscriptionFrom(audioIn, request) // live audio stream -> TranscriptEvent stream
```

The sync path only needs the generic `Transcriber` tag. The streaming
path also needs the [`SttStreaming`](/speech/#capability-markers)
marker, so sync-only providers fail at `Effect.provide`, not at
runtime.

## The Shape

```ts
interface TranscriberService {
  readonly transcribe: (req: CommonTranscribeRequest) => Effect<TranscriptResult, AiError>
  readonly streamTranscriptionFrom: <E, R>(
    audioIn: Stream<Uint8Array, E, R>,
    req: CommonStreamTranscribeRequest,
  ) => Stream<TranscriptEvent, AiError | E, R>
}
```

The cross-provider request bag:

```ts
type CommonTranscribeRequest = {
  readonly audio: AudioSource
  readonly model: string
  readonly language?: string // ISO-639-1 / BCP-47
  readonly prompt?: string | { readonly terms: ReadonlyArray<string> }
  readonly diarization?: boolean
  readonly wordTimestamps?: boolean
}

type CommonStreamTranscribeRequest = Omit<CommonTranscribeRequest, "audio"> & {
  readonly inputFormat: AudioFormat
  readonly interimResults?: boolean
  readonly vadEvents?: boolean
}
```

Providers ignore options they don't support, or reject them up front
with `AiError.Unsupported` / `AiError.InvalidRequest` — see the
per-provider pages.

## Sync — `transcribe`

Use this for uploads, recordings, podcasts, and batch jobs. `audio` is
an `AudioSource` (URL, base64, or bytes); the adapter handles the
provider's preferred wire form.

```ts
import { transcribe } from "@effect-uai/core/Transcriber"

const program = Effect.gen(function* () {
  const file = yield* readFile("meeting.mp3")
  return yield* transcribe({
    audio: { _tag: "bytes", bytes: file, mimeType: "audio/mpeg" },
    model: "gpt-4o-transcribe",
    language: "en",
  })
})
```

Returns `TranscriptResult`:

```ts
type TranscriptResult = {
  readonly text: string
  readonly languageCode?: string
  readonly durationSeconds?: number
  readonly words?: ReadonlyArray<WordTimestamp>
  readonly raw?: unknown
}
```

`words` only appears when `wordTimestamps: true` was requested **and**
the provider+model combination supports it. Today that means
OpenAI `whisper-1` only — `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`
return text-only; Gemini's prompt-driven STT has no structured timing.
Passing `wordTimestamps: true` to an unsupporting provider fails with
`AiError.Unsupported`.

## Streaming — `streamTranscriptionFrom`

Use this for live captions, voice search, or the front half of a voice
assistant. Audio bytes go in as a `Stream<Uint8Array>`. Transcript
events come out as partials, finals, and optional VAD events.

```ts
import { Stream } from "effect"
import * as Transcriber from "@effect-uai/core/Transcriber"

const transcripts = micFrames.pipe(
  Transcriber.streamTranscriptionFrom({
    model: "scribe_v2_realtime",
    inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
    interimResults: true,
  }),
  Stream.filter((e) => e._tag === "final"),
)
```

Both data-first (`streamTranscriptionFrom(audioIn, req)`) and
data-last forms work.

The underlying WebSocket is acquired on first pull and released when
the output stream finalizes. You do not manage the scope by hand.

## What You Get Back

`partial` updates are speculative. `final` is the committed text you
usually append to a transcript, send to search, or feed to an LLM.

```ts
type TranscriptEvent =
  | { readonly _tag: "partial"; readonly text: string; readonly words?: ...; readonly stability?: number }
  | { readonly _tag: "final"; readonly text: string; readonly words?: ...; readonly languageCode?: string }
  | { readonly _tag: "speech-started"; readonly atSeconds: number }
  | { readonly _tag: "utterance-ended"; readonly atSeconds: number }
  | { readonly _tag: "audio-event"; readonly label: string; ...} // (laughter), (music) — ElevenLabs
  | { readonly _tag: "metadata"; readonly raw: unknown }
  | { readonly _tag: "error"; readonly code?: string; readonly message: string }
```

Type guards live next to the union:

```ts
import * as Transcript from "@effect-uai/core/Transcript"

if (Transcript.isFinal(event)) {
  // event.text is the committed transcript
}
```

## Audio Format

`inputFormat` declares what's in the byte stream:

```ts
type AudioFormat = {
  readonly container: "mp3" | "wav" | "ogg" | "opus" | "flac" | "aac" | "webm" | "raw"
  readonly encoding: "pcm_s16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw" | "mp3" | "opus" | ...
  readonly sampleRate: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000
  readonly channels?: 1 | 2
}
```

Mismatches with what the provider's wire expects fail up front with
`AiError.InvalidRequest`. Common targets:

- **ElevenLabs Scribe v2 Realtime** — 16 kHz pcm s16le mono.
- **OpenAI Realtime** — 24 kHz pcm s16le mono.
- **Inworld realtime** — 16 kHz pcm s16le mono.

The browser side of a recipe typically uses an `AudioWorklet` to
decimate mic audio to the right rate before posting frames over a
WebSocket — see [streaming-transcription](/recipes/streaming-transcription/)
for the worklet.

VAD events (`speech-started`, `utterance-ended`) require
`vadEvents: true` and are not emitted by every provider. Non-fatal
provider issues can arrive as `_tag: "error"` events; fatal failures
still use the Stream error channel.

## Next step

- [Voice loop](/recipes/voice-loop/) — live mic → LLM → TTS, the
  flagship use of `streamTranscriptionFrom`.
- [Basic transcription](/recipes/basic-transcription/) — sync
  `transcribe` against OpenAI or Gemini.
- [Streaming transcription](/recipes/streaming-transcription/) — Bun
  server bridging a browser mic to the realtime endpoint.

## See also

- [Synthesis](/speech/synthesis/) — the other direction.
- Provider specifics: [OpenAI](/speech/providers/openai/),
  [ElevenLabs](/speech/providers/elevenlabs/),
  [Gemini](/speech/providers/gemini/),
  [Inworld](/speech/providers/inworld/).
