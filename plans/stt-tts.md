# Speech Provider Landscape — STT & TTS

Planning doc for adding speech-to-text (STT) and text-to-speech (TTS) provider abstractions to `effect-uai`, mirroring the existing LLM-provider abstraction.

Compiled 2026-05-11. Pricing and model names change quickly — always re-verify against the linked source before relying.

## Scope

**In scope**

- Streaming / low-latency endpoints (live mic→text; streamed TTS synthesis).
- Synchronous request/response endpoints (transcribe a file in one call; synthesize a string in one call).
- A `voiceId` field on the TTS abstraction that accepts custom/cloned voice IDs the user already owns.

**Out of scope (for this work session)**

- Batch / async-with-callback APIs (submit job, poll or webhook later).
- Realtime multimodal speech-to-speech models (GPT Realtime, Gemini Live, ElevenLabs Conversational AI). Handled in a separate session.
- Open-source self-hosted models.
- Voice-cloning _creation_ APIs (registering a new cloned voice). We only consume already-registered voice IDs.

---

## Provider-by-provider state

### OpenAI

**STT**

- Models (2026): `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, legacy `whisper-1`.
- Streaming: WebSocket via Realtime API (`wss://api.openai.com/v1/realtime?intent=transcription`) and HTTP `stream: true` on `/v1/audio/transcriptions`.
- Sync: `POST /v1/audio/transcriptions`.
- Pricing: `gpt-4o-transcribe` $0.006/min, `gpt-4o-mini-transcribe` $0.003/min, `whisper-1` $0.006/min.
- Features: word timestamps, language hint, prompt-based vocab biasing. No native diarization on the transcription endpoint.
- SDK: official `openai` Node SDK.

**TTS**

- Models (2026): `gpt-4o-mini-tts` (recommended, steerable), legacy `tts-1`, `tts-1-hd`.
- Streaming: chunked HTTP.
- Sync: `POST /v1/audio/speech`.
- Pricing: `gpt-4o-mini-tts` ~$0.015/min audio; `tts-1` $15/1M chars, `tts-1-hd` $30/1M chars.
- Voice IDs: fixed slugs only (`alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, `verse`). **No public voice cloning.**
- Controls: free-form `instructions` prompt for `gpt-4o-mini-tts` (tone, emotion, pacing). `speed` 0.25–4.0.
- Formats: mp3, opus, aac, flac, wav, pcm.

Sources: [pricing](https://openai.com/api/pricing/), [realtime WS](https://developers.openai.com/api/docs/guides/realtime-websocket).

---

### Google

Google ships two distinct API surfaces that we have to choose between (or both). Earlier drafts of this plan assumed only the gRPC-only Cloud Speech APIs existed; the Gemini API actually exposes both TTS and audio understanding over REST+JSON, with significant capability trade-offs.

#### Path A — Gemini API (REST + JSON)

Recommended **first** integration: shares HTTP stack with `@effect-uai/google` (the existing Gemini package) and runs on every JS runtime (no gRPC).

**TTS** — [docs](https://ai.google.dev/gemini-api/docs/speech-generation)

- Models: `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`, `gemini-3.1-flash-tts-preview`.
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `generationConfig.responseModalities: ["AUDIO"]` and `generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
- Voices: ~30 prebuilt (`Kore`, `Puck`, `Zephyr`, `Enceladus`, …) — string slugs, no project-scoped custom voices.
- Multi-speaker: up to 2 via `multiSpeakerVoiceConfig.speakerVoiceConfigs[]`.
- Response: `candidates[0].content.parts[0].inlineData.data` = base64 PCM 16-bit signed LE, 24 kHz mono.
- Streaming: **not supported** — sync only.
- Controls: prompt-level prosody (`[whispers]`, `[shouting]` tags + natural-language style direction). No SSML, no `speed`/`pitch` knobs.
- Languages: ~80 (auto-detected).

**Audio understanding (transcription-like)** — [docs](https://ai.google.dev/gemini-api/docs/audio)

- Models: `gemini-3-flash-preview` and other Gemini models that accept audio modality.
- Endpoint: `POST .../models/{model}:generateContent` with the audio supplied either inline (`inlineData.data` base64, ≤20 MB total request) or by Files API URI (`fileData.fileUri`, supports up to 9.5 h).
- Formats accepted: `audio/wav`, `audio/mp3`, `audio/aiff`, `audio/aac`, `audio/ogg`, `audio/flac`.
- Transcription is **prompt-driven**, not a dedicated endpoint: you ask "Transcribe this audio" (optionally with `responseSchema` for structured output). Timestamps come back only when the prompt requests them as `MM:SS` text.
- **Not supported**: streaming partial transcripts, word-level timestamps, language forcing, speaker diarization.

→ Maps cleanly onto our `SpeechSynthesizer.synthesize` and a _limited_ `Transcriber.transcribe`. Compile-time markers `SttStreaming` and `TtsIncrementalText` are **not provided** by this Layer. `wordTimestamps: true` and `diarization: true` on `transcribe` → `Unsupported` at runtime.

#### Path B — Cloud Speech-to-Text + Cloud Text-to-Speech (gRPC)

Full-featured fallback for users who need streaming STT/TTS or word timestamps. Separate package (`@effect-uai/google-cloud-speech`) because the gRPC stack adds ~3 MB of deps and doesn't run in browsers / Workers / Edge.

**STT**

- Models (2026): `chirp_2` (recommended, GA), legacy `latest_long`, `latest_short`, `telephony`.
- Streaming: gRPC `StreamingRecognize` bidirectional.
- Sync: `recognize` for <1 min audio. (`longrunningrecognize` is poll-based — out of scope.)
- Pricing: $0.016/min standard real-time; 60 free min/month.
- Features: diarization, word timestamps, automatic punctuation, profanity filter, model adaptation/biasing phrases, language detection, translation.
- Languages: Chirp 2 ~100+; Chirp ~125.
- SDK: `@google-cloud/speech`.

**TTS**

- Models (2026): `Chirp 3: HD` voices (recommended; supports text streaming), Neural2, WaveNet, Studio, Standard.
- Streaming: bidirectional gRPC for Chirp 3 HD; non-streaming endpoint for other engines.
- Sync: `synthesize`.
- Pricing: Chirp 3 HD $30/1M chars, Neural2/Studio $16/1M, WaveNet $16/1M, Standard $4/1M.
- Voice IDs: slug strings like `en-US-Chirp3-HD-Aoede`. Custom Voice available via paid program (project-scoped voice IDs).
- Catalog: 220+ standard voices across 40+ languages; ~30 Chirp 3 HD voices.
- Controls: SSML, speaking rate, pitch, volume gain.
- Formats: LINEAR16 PCM, MP3, OGG_OPUS, MULAW, ALAW; configurable sample rate.
- SDK: `@google-cloud/text-to-speech`.

Sources: [Gemini speech generation](https://ai.google.dev/gemini-api/docs/speech-generation), [Gemini audio understanding](https://ai.google.dev/gemini-api/docs/audio), [Cloud STT pricing](https://cloud.google.com/speech-to-text/pricing), [Cloud TTS pricing](https://cloud.google.com/text-to-speech/pricing), [Chirp 3 HD docs](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd).

---

### ElevenLabs

**STT**

- Models (2026): `scribe_v2_realtime` (streaming, recommended), `scribe_v1` (sync).
- Streaming: WebSocket at `wss://api.elevenlabs.io/v1/speech-to-text/realtime`. ~150 ms claimed latency.
- Sync: `POST /v1/speech-to-text`.
- Pricing: realtime starts ~$0.28/hr on annual Business plans; Scribe credit-based on standard plans.
- Features: diarization, word timestamps, language detection, audio-event tags (laughter, music).
- Languages: ~30 main + claims of 90 supported with reduced accuracy.
- SDK: `@elevenlabs/elevenlabs-js`.

**TTS**

- Models (2026): `eleven_v3` (most expressive), `eleven_multilingual_v2` (production multilingual), `eleven_turbo_v2_5`, `eleven_flash_v2_5` (~75 ms model latency).
- Streaming: chunked HTTP `/v1/text-to-speech/{voice_id}/stream` and WebSocket `/v1/text-to-speech/{voice_id}/stream-input` for incremental text-in.
- Sync: `/v1/text-to-speech/{voice_id}`.
- Pricing: credit-based — roughly $0.06/1K chars Flash/Turbo, $0.12/1K chars Multilingual v2 / v3 (varies by tier).
- Voice IDs: 20-character alphanumeric strings (e.g. `JBFqnCBsd6RMkjVDRZzb`). Cloned voices use the same format.
- Catalog: 11,000+ (premade + community + cloned).
- Languages: v3 70+; Flash/Turbo v2.5 32; Multilingual v2 29.
- Controls: `stability`, `similarity_boost`, `style`, `use_speaker_boost`, `speed`. v3 supports inline audio-tag emotion directives.
- Formats: mp3 (multiple bitrates), pcm 16/22/24/44 kHz, μ-law 8 kHz, opus.
- SDK: `@elevenlabs/elevenlabs-js`.

Sources: [models](https://elevenlabs.io/docs/overview/models), [realtime STT](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime), [pricing](https://elevenlabs.io/pricing/api).

---

### Deepgram

**STT**

- Models (2026): `nova-3` (recommended; multilingual code-switching, ~5.3% WER), `nova-3-medical`, `nova-3-multilingual`. `nova-2` still available.
- Streaming: WebSocket at `wss://api.deepgram.com/v1/listen`. Sub-300 ms.
- Sync: `POST /v1/listen` (file or URL).
- Pricing: Nova-3 streaming $0.0077/min ($0.46/hr) PAYG; Growth tier $0.0065/min. Billed per second.
- Features: diarization, smart formatting, filler words, profanity filter, redaction, summarization, sentiment, topics, Keyterm Prompting (up to 100 terms).
- Languages: ~36 monolingual + multilingual code-switching across 10.
- SDK: `@deepgram/sdk` (first-class Node).

**TTS**

- Models (2026): `aura-2` (recommended; ~90 ms first audio), `aura-1` legacy.
- Streaming: WebSocket and chunked HTTP at `/v1/speak`.
- Sync: `/v1/speak`.
- Pricing: $30/1M chars PAYG; Growth $27/1M.
- Voice IDs: named slugs like `aura-2-thalia-en`. **No public voice cloning.**
- Catalog: 40+ Aura-2 voices, English-focused.
- Controls: limited — voice, sample rate, encoding. Prosody not exposed.
- Formats: linear16, mulaw, alaw, mp3, opus, flac, aac; configurable sample rate.
- SDK: `@deepgram/sdk`.

Sources: [pricing](https://deepgram.com/pricing), [Nova-3](https://deepgram.com/learn/introducing-nova-3-speech-to-text-api), [Aura-2](https://deepgram.com/learn/introducing-aura-2-enterprise-text-to-speech).

---

### AssemblyAI

**STT**

- Models (2026): `universal-streaming` (recommended for voice agents, multilingual), `universal-2` (sync, 99 languages), `universal-3-pro` (highest-accuracy pre-recorded).
- Streaming: WebSocket at `wss://streaming.assemblyai.com/v3/ws`. ~300 ms P50.
- Sync: `POST /v2/transcript` with audio URL.
- Pricing: Universal-Streaming $0.15/hr **billed on session duration — open WS even when idle counts**. Universal-2 file $0.15/hr. Universal-3 Pro $0.27/hr. Keyterms add-on $0.04/hr.
- Features: diarization, word timestamps, punctuation, profanity filter, PII redaction, content moderation, keyterm prompting, LeMUR audio intelligence.
- Languages: Universal-2 99; Streaming multilingual.
- SDK: `assemblyai` (official Node).

**TTS**: none.

Sources: [pricing](https://www.assemblyai.com/pricing), [streaming](https://www.assemblyai.com/products/streaming-speech-to-text).

---

### Cartesia

**STT**

- Models (2026): `ink-whisper` (real-time optimized).
- Streaming: WebSocket.
- Sync: REST.
- Pricing: ~$0.13/hr (1 credit/audio second) on Scale plan.
- Languages: English-strong; multilingual coverage limited vs competitors.
- SDK: `@cartesia/cartesia-js`.

**TTS**

- Models (2026): `sonic-3` (recommended; expressive), `sonic-2`, `sonic-turbo`.
- Streaming: WebSocket with text-in streaming and HTTP chunked. **~40–90 ms first audio (industry-leading).**
- Sync: REST `/tts/bytes`.
- Pricing: ~$0.030/min generated audio (1 credit/char); Pro Voice Clone 1.5 credit/char.
- Voice IDs: UUIDs (e.g. `a0e99841-438c-4a64-b679-ae501e7d6091`). Cloned voices use the same format.
- Catalog: ~100 stock voices.
- Languages: Sonic-3 covers 42 with native voices.
- Controls: emotion tags, speed, language override, voice mixing.
- Formats: WAV/PCM (f32le, s16le), MP3, μ-law; configurable sample rate.
- SDK: `@cartesia/cartesia-js`.

Sources: [pricing](https://cartesia.ai/pricing), [Sonic-3](https://cartesia.ai/sonic), [Ink](https://cartesia.ai/blog/introducing-ink-speech-to-text).

---

### Inworld AI

**STT**

- Offered in the Voice AI stack but not a market lead. Verify current model name before adoption.
- Streaming and sync, WebSocket-based.
- Pricing bundled into the credit pool ($15–$25 per 1M units depending on tier).
- TS SDK available.

**TTS**

- Models (2026): `realtime-tts-2` (newest flagship, expressive), `realtime-tts-1.5` / `realtime-tts-1.5-max` (sub-120/200 ms P90), `inworld-tts-1` (Mini), `inworld-tts-1-max`.
- Streaming: WebSocket with low first-token latency.
- Sync: REST.
- Pricing: $15/1M chars Mini, $25/1M chars Max — among the cheapest premium TTS (~$0.01/min).
- Voice IDs: named voice IDs; supports voice clones.
- Catalog: smaller curated set.
- Controls: style/emotion via prompt and tags.
- Formats: PCM, WAV, MP3, Opus.
- SDK: TS SDK + OpenAI-compatible endpoint.

Sources: [pricing](https://inworld.ai/pricing), [TTS launch](https://inworld.ai/blog/introducing-inworld-tts).

---

### MiniMax

**STT**: no first-party public STT API at writing — verify before scoping.

**TTS**

- Models (2026): `speech-02-hd`, `speech-02-turbo`, `speech-2.6-turbo` (latest real-time).
- Streaming: HTTP chunked with `stream=true` and WebSocket (`/ws/v1/t2a_v2`).
- Sync: `POST /v1/t2a_v2` (up to 10K chars per request).
- Pricing: $0.06/1K input tokens (token ≈ char); audio output free. Voice-clone first use ~$0.50.
- Voice IDs: string IDs (e.g. `male-qn-qingse`); cloned voices use user-supplied IDs.
- Catalog: ~300 stock voices, Chinese-strong.
- Languages: 30+; strong in Chinese, Japanese, Korean, English. Speech-02 advertises >40.
- Controls: speed, volume, pitch, emotion, voice mixing, language boost.
- Formats: mp3, pcm, flac, wav; sample rates 8–44 kHz.
- SDK: REST-first; community Node clients. **No official TS SDK at writing — verify.**

Sources: [API overview](https://platform.minimax.io/docs/api-reference/api-overview), [Speech-02](https://www.minimax.io/news/speech-02-series).

---

### Azure (Microsoft Cognitive Services / Foundry Speech)

**STT**

- Models: managed Azure STT line; Whisper-on-Azure also offered. Custom Speech for vocab adaptation.
- Streaming: WebSocket via Speech SDK (continuous recognition).
- Sync: REST short-audio API.
- Pricing: $1/hr ($0.0167/min) standard real-time; enhanced features +$0.30/hr each (diarization, language ID, pronunciation assessment). Commitment tiers down to $0.50/hr.
- Languages: 100+ locales.
- Features: diarization, word timestamps, profanity filter/masking, custom vocab/Custom Speech, pronunciation assessment, translation.
- SDK: `microsoft-cognitiveservices-speech-sdk`.

**TTS**

- Models (2026): Neural HD voices (recommended), Neural voices, Custom Neural Voice (training), Personal Voice (zero-shot clone).
- Streaming: yes via Speech SDK.
- Sync: REST.
- Pricing: Neural $15/1M chars, Neural HD $22/1M chars (reduced March 2026), Custom Pro Voice $24/1M ($48 HD), Personal Voice $24/1M.
- Voice IDs: slugs like `en-US-AvaMultilingualNeural`. Custom voices use a deployment ID.
- Catalog: **500+ voices across 140+ locales — broadest stock catalog.**
- Controls: SSML (rate, pitch, volume, style, role, prosody), `mstts:express-as` style tags.
- Formats: many — riff PCM, mp3, ogg-opus, mu-law, raw PCM at multiple sample rates.
- SDK: Speech SDK.

Sources: [pricing](https://azure.microsoft.com/en-us/pricing/details/speech/), [Neural HD update](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/azure-speech-%E2%80%93-neural-hd-text-to-speech-recent-voice-updates/4505380).

---

### AWS

**STT — Amazon Transcribe**

- Models: single managed model; standard and medical/call-analytics variants.
- Streaming: HTTP/2 streaming and WebSocket. Partial result stabilization.
- Sync: `StartTranscriptionJob` is **async/polling — out of scope.** Streaming covers the low-latency single-pass use case; AWS has no true "sync file in / transcript out" endpoint in scope.
- Pricing: $0.024/min Tier 1 (first 250K min), tiered down to $0.0078/min at 5M+ min/month.
- Languages: 100+ via automatic language ID.
- Features: diarization, custom vocab, vocabulary filtering, PII redaction, language ID.
- SDK: `@aws-sdk/client-transcribe-streaming`.

**TTS — Amazon Polly**

- Models (2026): `generative` (recommended, now with bidirectional streaming as of March 2026), `long-form`, `neural`, `standard`.
- Streaming: `SynthesizeSpeech` chunked HTTP; bidirectional streaming for Generative.
- Sync: `SynthesizeSpeech`.
- Pricing: Generative $30/1M chars; Long-form $100/1M; Neural $16/1M; Standard $4/1M.
- Voice IDs: named slugs (`Joanna`, `Matthew`, `Aria`, …). **No public voice cloning.**
- Catalog: 100+ voices across engines; ~20+ Generative.
- Controls: SSML (limited subset on Generative), speech marks.
- Formats: mp3, ogg-vorbis, pcm.
- SDK: `@aws-sdk/client-polly`.

Sources: [Polly pricing](https://aws.amazon.com/polly/pricing/), [Transcribe pricing](https://aws.amazon.com/transcribe/pricing/), [Polly bidirectional streaming](https://aws.amazon.com/blogs/machine-learning/introducing-amazon-polly-bidirectional-streaming-real-time-speech-synthesis-for-conversational-ai/).

---

### Hume AI

**STT**: none in scope (Hume's voice product is emotion analysis, not general transcription).

**TTS — Octave**

- Models (2026): `octave-2` (recommended; 50% cheaper than v1), `octave` legacy.
- Streaming: streamed JSON, streamed file (raw audio bytes), and WebSocket for incremental text-in. ~100 ms latency, ~200 ms TTFT.
- Sync: yes.
- Pricing: $7.60/1M chars PAYG; lower on Business+ ($0.05/1K chars).
- Voice IDs: named voices + UUIDs for saved custom voices (created from samples or natural-language "voice design").
- Catalog: smaller curated stock library; emphasis on user-designed voices.
- Languages: ~11.
- Controls: emotion/acting instructions via natural-language `description` field per utterance — Octave's differentiator.
- Formats: MP3, WAV, OGG, FLAC, raw PCM.
- SDK: `hume`.

Sources: [TTS overview](https://dev.hume.ai/docs/text-to-speech-tts/overview), [pricing](https://www.hume.ai/pricing).

---

## Comparison summary

**Streaming STT latency leaders**: ElevenLabs Scribe v2 Realtime (~150 ms claimed) and Deepgram Nova-3 (~250–300 ms via WSS). Cartesia Ink-Whisper is sub-300 ms and the cheapest at $0.13/hr. AssemblyAI Universal-Streaming hits ~300 ms P50 but the session-duration billing (idle WS counts) is a footgun.

**Streaming TTS latency leaders**: Cartesia Sonic-3 (40–90 ms first audio) is the clearest leader, followed by Deepgram Aura-2 (~90 ms) and Inworld realtime-tts-1.5 (sub-120 ms P90). ElevenLabs Flash v2.5 advertises ~75 ms model latency but real-world wall-clock typically sits at 150 ms+.

**Broadest language coverage**: Azure (140+ TTS locales, 100+ STT). Google a close second. AssemblyAI Universal-2 covers 99 languages for STT. ElevenLabs v3 leads expressive multilingual TTS (70+).

**Strongest voice catalog / custom voice support**: ElevenLabs (11,000+ voices, instant + professional cloning). Azure runner-up (500+ stock + Personal/Custom Neural Voice). Cartesia and Hume strong on per-developer custom voice creation.

**Custom voice ID support — relevant to the abstraction**:

| Provider   | Stock voices | Custom voice IDs in API | ID format            |
| ---------- | ------------ | ----------------------- | -------------------- |
| OpenAI     | yes          | **no**                  | fixed slug           |
| Google     | yes          | yes (paid program)      | project-scoped slug  |
| ElevenLabs | yes          | yes                     | 20-char alphanumeric |
| Deepgram   | yes          | **no**                  | named slug           |
| AssemblyAI | n/a (no TTS) | —                       | —                    |
| Cartesia   | yes          | yes                     | UUID                 |
| Inworld    | yes          | yes                     | named ID             |
| MiniMax    | yes          | yes                     | user-supplied string |
| Azure      | yes          | yes (Personal / Custom) | slug / deployment ID |
| AWS Polly  | yes          | **no**                  | named slug           |
| Hume       | yes          | yes                     | named + UUID         |

**Notably absent and why**

- Realtime speech-to-speech (GPT Realtime, Gemini Live, ElevenLabs Conversational AI) — explicitly out of scope; separate session.
- Speechmatics, Gladia, Rev AI, PlayHT, Resemble AI, Wellsaid — credible but second-tier in mindshare; defer until the abstraction is proven on the primary set.
- Groq Whisper — extremely fast hosted Whisper; consider as a budget tier if we want a cheap sync STT path.
- Sarvam, Krutrim — strong Indic-language coverage; niche unless an explicit user need surfaces.

---

## Implications for the abstraction

1. **Billing units differ** — per character, per token, per minute of audio, per session-duration. Model billing as a tagged union in provider metadata, not a single `costPerMinute`.
2. **Streaming transports differ** — WebSocket, gRPC bidirectional, HTTP chunked, HTTP/2. The provider adapter should expose uniform `Stream<TranscriptEvent>` (STT) and `Stream<AudioChunk>` (TTS) regardless of underlying transport.
3. **Voice ID format varies** — slug, UUID, 20-char alphanum, user-supplied string. Treat `voiceId` as opaque `string` at the abstraction layer; per-provider request types narrow to a typed literal union + `(string & {})` escape (mirroring `OpenAIModel`).
4. **Capability flags worth surfacing**
   - STT: `diarization`, `wordTimestamps`, `languageDetection`, `keyterms` / vocab biasing, `profanityFilter`, `interimResults`.
   - TTS: `streamingTextInput` (WS incremental text), `emotionControl`, `speed`, `pitch`, `style`, `outputFormat`, `sampleRate`.
     Not all providers expose all — model as optional with per-provider capability detection.
5. **Operational hazards** to surface in provider metadata:
   - AssemblyAI streaming bills on open-WebSocket time, not audio time.
   - AWS Transcribe has no real sync file endpoint — only streaming or async-job.
   - AWS Transcribe and Deepgram Growth use stepped/tiered pricing — `costPerMinute` is volume-dependent.
   - OpenAI, Deepgram Aura, and AWS Polly are stock-voice only — a `voiceId` field will only resolve to catalog slugs on those providers.

---

# Design: cross-provider abstraction

Two services, mirroring the existing `LanguageModel` and `EmbeddingModel` patterns. Wire-shape research that motivates each decision is in [stt-tts-wire.md](./stt-tts-wire.md).

## Domain types — new module `core/src/domain/Audio.ts`

```ts
import type { Stream } from "effect"
import type { MediaBase64, MediaBytes, MediaUrl } from "./Media.js"

/**
 * MIME types we care about across STT input and TTS output. Container-
 * level only — sample rate / encoding flavours live on `AudioFormat`.
 *
 * Per-provider request types narrow this further (e.g. OpenAI rejects
 * raw L16 sync; Deepgram rejects ogg-flac as TTS output).
 */
export type AudioMimeType =
  | "audio/mpeg" // mp3
  | "audio/wav"
  | "audio/x-wav"
  | "audio/ogg" // container only — codec is opus|vorbis|flac
  | "audio/opus"
  | "audio/flac"
  | "audio/aac"
  | "audio/mp4" // m4a
  | "audio/webm"
  | "audio/L16" // raw PCM 16-bit
  | "audio/pcm"
  | "audio/mulaw"
  | "audio/alaw"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Audio at rest — mirrors `MediaSource` but typed against `AudioMimeType`.
 * Used for sync STT input. URL variant is best-effort: some providers
 * (OpenAI, Cartesia, Azure short-audio) reject it and the adapter must
 * upload via file path instead.
 */
export type AudioSource =
  | MediaUrl<AudioMimeType>
  | MediaBase64<AudioMimeType>
  | MediaBytes<AudioMimeType>

/**
 * Structural audio format. Used both as TTS output spec and as STT
 * streaming-input declaration. Providers that use compound slugs
 * (`mp3_44100_128`, `audio-16khz-128kbitrate-mono-mp3`) are encoded at
 * the adapter layer.
 */
export type AudioFormat = {
  readonly container: "mp3" | "wav" | "ogg" | "opus" | "flac" | "aac" | "webm" | "raw"
  readonly encoding:
    | "pcm_s16le"
    | "pcm_f32le"
    | "pcm_mulaw"
    | "pcm_alaw"
    | "mp3"
    | "opus"
    | "vorbis"
    | "flac"
    | "aac"
  readonly sampleRate: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000
  readonly bitRate?: number
  readonly channels?: 1 | 2
}

/**
 * Streamed audio chunk. `bytes` carries the codec-encoded payload as
 * declared on the session's `AudioFormat`. No per-chunk timestamp here
 * — providers that emit timing do so in `TranscriptEvent`.
 */
export type AudioChunk = {
  readonly bytes: Uint8Array
}

/**
 * Full audio result for sync TTS. Format is whatever the request asked
 * for; provider layers normalize.
 */
export type AudioBlob = {
  readonly format: AudioFormat
  readonly bytes: Uint8Array
  readonly durationSeconds?: number
}
```

## Transcript types — new module `core/src/domain/Transcript.ts`

```ts
export type WordTimestamp = {
  readonly text: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly confidence?: number
  readonly speakerId?: string
  readonly languageCode?: string
}

/**
 * Sync STT result. `raw` preserves the provider-specific response for
 * consumers that need fields the common shape doesn't expose
 * (alternatives, segments, NBest, etc.).
 */
export type TranscriptResult = {
  readonly text: string
  readonly languageCode?: string
  readonly durationSeconds?: number
  readonly words?: ReadonlyArray<WordTimestamp>
  readonly raw?: unknown
}

/**
 * Streaming STT event union. Collapses every provider's vocabulary
 * into a small set; provider-specific shapes survive on `metadata.raw`.
 *
 * - `partial`: interim hypothesis. `stability` is Google-only.
 * - `final`:   committed transcript for the current utterance / segment.
 * - `speech-started` / `utterance-ended`: VAD-derived boundaries; not
 *   all providers emit them (OpenAI Realtime, Google with `voice_activity
 *   _events`, Deepgram with `vad_events`).
 * - `audio-event`: non-speech label (`(laughter)`, `(music)`); ElevenLabs only.
 * - `metadata`: opaque server-side bookkeeping (request_id, model info).
 * - `error`: non-fatal provider error mid-session. Fatal errors surface
 *   as `AiError` on the Stream's error channel.
 */
export type TranscriptEvent =
  | {
      readonly _tag: "partial"
      readonly text: string
      readonly words?: ReadonlyArray<WordTimestamp>
      readonly stability?: number
    }
  | {
      readonly _tag: "final"
      readonly text: string
      readonly words?: ReadonlyArray<WordTimestamp>
      readonly languageCode?: string
    }
  | { readonly _tag: "speech-started"; readonly atSeconds: number }
  | { readonly _tag: "utterance-ended"; readonly atSeconds: number }
  | {
      readonly _tag: "audio-event"
      readonly label: string
      readonly startSeconds: number
      readonly endSeconds: number
    }
  | { readonly _tag: "metadata"; readonly raw: unknown }
  | { readonly _tag: "error"; readonly code?: string; readonly message: string }
```

## Transcriber service — new module `core/src/transcriber/Transcriber.ts`

````ts
import { Context, Effect, Function, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { AudioFormat, AudioSource } from "../domain/Audio.js"
import type { TranscriptEvent, TranscriptResult } from "../domain/Transcript.js"

/**
 * Cross-provider sync transcription request. Provider-specific
 * extensions (Deepgram `keyterm[]`, ElevenLabs `diarize`, Google
 * `adaptation`) live on each provider's typed request which extends
 * this and narrows `model`.
 */
export type CommonTranscribeRequest = {
  readonly audio: AudioSource
  /** Model identifier. Each provider narrows to its typed literal union. */
  readonly model: string
  /** ISO-639-1 / BCP-47. Omit for autodetection (where supported). */
  readonly language?: string
  /**
   * Vocab biasing. Single-string covers OpenAI/Whisper-style prompts;
   * `terms[]` covers Deepgram `keyterm`, Google adaptation phrases, AWS
   * `vocabularyName`. Providers ignore what they don't support.
   */
  readonly prompt?: string | { readonly terms: ReadonlyArray<string> }
  readonly diarization?: boolean
  readonly wordTimestamps?: boolean
}

/**
 * Streaming-transcription request. `inputFormat` declares what the bytes
 * in the input stream will look like — providers reject mismatches at
 * stream startup.
 */
export type CommonStreamTranscribeRequest = Omit<CommonTranscribeRequest, "audio"> & {
  readonly inputFormat: AudioFormat
  readonly interimResults?: boolean
  readonly vadEvents?: boolean
}

export type TranscriberService = {
  /**
   * One-shot transcription. Returns the full result. Universal —
   * AWS Transcribe (which has no native sync endpoint) emulates this
   * by draining a streaming session internally.
   */
  readonly transcribe: (
    request: CommonTranscribeRequest,
  ) => Effect.Effect<TranscriptResult, AiError.AiError>
  /**
   * Live transcription as a Stream transformer. Consumes audio bytes
   * from `audioIn`, emits `TranscriptEvent`s as they arrive. The
   * underlying WS / gRPC connection is acquired on first pull and
   * released when the output stream is finalized (success, failure, or
   * interruption) — no explicit Scope handling needed at the call site.
   *
   * Gated by the `SttStreaming` capability marker — only providers
   * that ship the marker in their Layer can be used here.
   */
  readonly streamTranscriptionFrom: <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ) => Stream.Stream<TranscriptEvent, AiError.AiError | E, R>
}

export class Transcriber extends Context.Service<Transcriber, TranscriberService>()(
  "@effect-uai/Transcriber",
) {}

/**
 * Capability marker — provided by provider layers whose
 * `streamTranscriptionFrom` is wired up at the wire level. Azure does
 * not provide it (SDK-only at wire level). Calling
 * `streamTranscriptionFrom` while only Azure's Layer is in scope fails
 * at `Effect.provide` with a type error, not at runtime.
 */
export class SttStreaming extends Context.Tag("@effect-uai/capability/SttStreaming")<
  SttStreaming,
  void
>() {}

export const transcribe = (
  request: CommonTranscribeRequest,
): Effect.Effect<TranscriptResult, AiError.AiError, Transcriber> =>
  Effect.flatMap(Transcriber.asEffect(), (t) => t.transcribe(request))

/**
 * Dual-arity: pipeable (data-last) and direct (data-first). Requires
 * `SttStreaming` in R — providers without streaming-STT support are
 * a type error at provide time.
 *
 * ```ts
 * // Pipeable — composes with other Stream operators
 * mic.frames.pipe(
 *   Transcriber.streamTranscriptionFrom(req),
 *   Stream.filter((e) => e._tag === "final"),
 * )
 *
 * // Direct
 * Transcriber.streamTranscriptionFrom(mic.frames, req)
 * ```
 */
export const streamTranscriptionFrom: {
  (
    request: CommonStreamTranscribeRequest,
  ): <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
  ) => Stream.Stream<TranscriptEvent, AiError.AiError | E, R | Transcriber | SttStreaming>
  <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ): Stream.Stream<TranscriptEvent, AiError.AiError | E, R | Transcriber | SttStreaming>
} = Function.dual(
  2,
  <E, R>(audioIn: Stream.Stream<Uint8Array, E, R>, request: CommonStreamTranscribeRequest) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const t = yield* Transcriber
        yield* SttStreaming // phantom — no value used, marker contributes to R only
        return t.streamTranscriptionFrom(audioIn, request)
      }),
    ),
)
````

## SpeechSynthesizer service — new module `core/src/speech-synthesizer/SpeechSynthesizer.ts`

````ts
import { Context, Effect, Function, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { AudioBlob, AudioChunk, AudioFormat } from "../domain/Audio.js"

/**
 * Cross-provider synthesis request. Provider-specific extensions
 * (ElevenLabs `stability` / `similarity_boost`, Cartesia `emotion`,
 * Azure SSML style tags) live on each provider's typed request which
 * extends this and narrows `model` and `voiceId`.
 */
export type CommonSynthesizeRequest = {
  readonly text: string
  /** Model identifier. Each provider narrows. */
  readonly model: string
  /**
   * Voice identifier. Per-provider request types narrow this to a typed
   * literal union of stock voices + `(string & {})` escape for custom
   * cloned voice IDs. Providers without custom-voice support (OpenAI,
   * Deepgram Aura, AWS Polly) narrow to the stock-only union.
   */
  readonly voiceId: string
  readonly outputFormat?: AudioFormat
  readonly speed?: number
  readonly languageCode?: string
}

/**
 * Incremental-synthesis request — text arrives as a `Stream<string>`.
 * Gated by the `TtsIncrementalText` capability marker; only provider
 * layers that include the marker (ElevenLabs, Cartesia, Deepgram,
 * Inworld, MiniMax, Google with Chirp 3 HD voices) accept calls here.
 *
 * Multi-context features (Cartesia `context_id`, ElevenLabs `multi-
 * stream-input`) are NOT exposed here — one logical utterance per call.
 * Provider extensions can expose `forkContext` for that.
 */
export type CommonStreamSynthesizeRequest = Omit<CommonSynthesizeRequest, "text">

export type SpeechSynthesizerService = {
  /** One-shot. Full text in, full audio bytes out. Universally supported. */
  readonly synthesize: (
    request: CommonSynthesizeRequest,
  ) => Effect.Effect<AudioBlob, AiError.AiError>
  /**
   * Full text in, audio chunks streamed out (chunked HTTP). Universally
   * supported across providers that offer any streaming TTS at all.
   */
  readonly streamSynthesis: (
    request: CommonSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  /**
   * Incremental text in (as a Stream), audio chunks streamed out. The
   * underlying WS connection is acquired on first pull and released
   * when the output stream is finalized — no explicit Scope handling
   * needed at the call site.
   *
   * Gated by the `TtsIncrementalText` capability marker — only providers
   * that ship the marker in their Layer can be used here.
   */
  readonly streamSynthesisFrom: <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: CommonStreamSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R>
}

export class SpeechSynthesizer extends Context.Service<
  SpeechSynthesizer,
  SpeechSynthesizerService
>()("@effect-uai/SpeechSynthesizer") {}

/**
 * Capability marker — provided by provider layers whose
 * `streamSynthesisFrom` is wired up at the wire level. OpenAI, Azure
 * (wire), and AWS Polly non-Generative do not provide it. Calling
 * `streamSynthesisFrom` while only one of those Layers is in scope
 * fails at `Effect.provide` with a type error.
 */
export class TtsIncrementalText extends Context.Tag("@effect-uai/capability/TtsIncrementalText")<
  TtsIncrementalText,
  void
>() {}

export const synthesize = (
  request: CommonSynthesizeRequest,
): Effect.Effect<AudioBlob, AiError.AiError, SpeechSynthesizer> =>
  Effect.flatMap(SpeechSynthesizer.asEffect(), (s) => s.synthesize(request))

export const streamSynthesis = (
  request: CommonSynthesizeRequest,
): Stream.Stream<AudioChunk, AiError.AiError, SpeechSynthesizer> =>
  Stream.unwrap(Effect.map(SpeechSynthesizer.asEffect(), (s) => s.streamSynthesis(request)))

/**
 * Dual-arity: pipeable (data-last) and direct (data-first). Requires
 * `TtsIncrementalText` in R.
 *
 * ```ts
 * // Pipeable — chain straight off an LLM token stream
 * const audio = LanguageModel.streamTurn(turnReq).pipe(
 *   Stream.filterMap(Turn.toTextDelta),
 *   SpeechSynthesizer.streamSynthesisFrom(synthReq),
 * )
 *
 * // Direct — equivalent
 * SpeechSynthesizer.streamSynthesisFrom(textStream, synthReq)
 * ```
 */
export const streamSynthesisFrom: {
  (
    request: CommonStreamSynthesizeRequest,
  ): <E, R>(
    textIn: Stream.Stream<string, E, R>,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R | SpeechSynthesizer | TtsIncrementalText>
  <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: CommonStreamSynthesizeRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError | E, R | SpeechSynthesizer | TtsIncrementalText>
} = Function.dual(
  2,
  <E, R>(textIn: Stream.Stream<string, E, R>, request: CommonStreamSynthesizeRequest) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const s = yield* SpeechSynthesizer
        yield* TtsIncrementalText // phantom — marker contributes to R only
        return s.streamSynthesisFrom(textIn, request)
      }),
    ),
)
````

## End-to-end pipeline example

The dual-arity functions let mic→STT→LLM→TTS→speaker read top-to-bottom:

```ts
const audioOut = mic.frames.pipe(
  Transcriber.streamTranscriptionFrom(sttReq),
  Stream.filterMap((e) => (e._tag === "final" ? Option.some(e.text) : Option.none())),
  Stream.flatMap((userText) =>
    LanguageModel.streamTurn({
      ...llmReq,
      history: [...history, Items.user(userText)],
    }).pipe(Stream.filterMap(Turn.toTextDelta)),
  ),
  SpeechSynthesizer.streamSynthesisFrom(ttsReq),
)

yield * Stream.runForEach(audioOut, (chunk) => speaker.write(chunk.bytes))
```

No Queues, no explicit Scope, no fiber forks. Interrupt the consumer and every transport in the chain tears down structurally.

## Provider extension pattern

Mirrors how `Responses.ts` extends `LanguageModel.CommonRequest`:

```ts
// packages/providers/responses/src/OpenAITranscriber.ts
export type OpenAITranscribeRequest = Omit<CommonTranscribeRequest, "model"> & {
  readonly model: OpenAITranscribeModel // "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "whisper-1"
  readonly temperature?: number
  readonly responseFormat?: "json" | "verbose_json" | "srt" | "vtt" | "text"
  readonly timestampGranularities?: ReadonlyArray<"word" | "segment">
}

export type OpenAISynthesizeRequest = Omit<CommonSynthesizeRequest, "model" | "voiceId"> & {
  readonly model: OpenAITtsModel // "gpt-4o-mini-tts" | "tts-1" | "tts-1-hd"
  readonly voiceId: OpenAIVoiceId // typed literal union (no custom voice escape)
  readonly instructions?: string // gpt-4o-mini-tts only
}
```

For TTS voice IDs:

```ts
// Stock-only provider (OpenAI):
export type OpenAIVoiceId =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "fable"
  | "onyx"
  | "nova"
  | "sage"
  | "shimmer"
  | "verse"
// No `(string & {})` — there is no custom-voice path.

// Provider with custom voice cloning (ElevenLabs):
export type ElevenLabsVoiceId =
  | "JBFqnCBsd6RMkjVDRZzb" // Rachel
  | "21m00Tcm4TlvDq8ikWAM" // Drew
  // ... curated stock IDs
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {}) // accepts cloned voice IDs
```

Provider-typed service tags (one per service-per-provider) follow the existing pattern from `Responses`:

```ts
export class OpenAITranscriber extends Context.Service<
  OpenAITranscriber,
  OpenAITranscriberService
>()("@effect-uai/responses/OpenAITranscriber") {}
```

Yielding `OpenAITranscriber` gives you the typed request with `temperature` / `responseFormat`; yielding the generic `Transcriber` gives you the cross-provider shape.

## Capability gating — two-layer strategy

Capability gaps come in two flavors. The strategy uses Effect's R channel for one, runtime errors for the other.

### Layer 1: provider-level gaps → R-channel marker tags (compile-time)

For methods a provider can _never_ offer at the wire level (independent of request data), the top-level helper threads a phantom marker tag into the `R` channel. Provider layers only include the marker in their output type if the provider supports it. Calling a gated method on a provider that doesn't supply the marker fails at `Effect.provide` — type error, no runtime check.

```ts
// In core/src/speech-synthesizer/SpeechSynthesizer.ts
export class TtsIncrementalText extends Context.Tag("@effect-uai/capability/TtsIncrementalText")<
  TtsIncrementalText,
  void
>() {}

// In core/src/transcriber/Transcriber.ts
export class SttStreaming extends Context.Tag("@effect-uai/capability/SttStreaming")<
  SttStreaming,
  void
>() {}
```

The top-level helpers yield the marker so it bubbles into `R`:

```ts
export const streamSynthesisFrom: {
  (
    req: CommonStreamSynthesizeRequest,
  ): <E, R>(
    textIn: Stream.Stream<string, E, R>,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R | SpeechSynthesizer | TtsIncrementalText>
  // ...
}
```

Provider layers declare what they provide:

```ts
export const ElevenLabsLive: Layer.Layer<SpeechSynthesizer | TtsIncrementalText>
export const OpenAILive: Layer.Layer<SpeechSynthesizer> // no TtsIncrementalText
```

Call site:

```ts
const audio = textStream.pipe(SpeechSynthesizer.streamSynthesisFrom(req))
// audio: Stream<..., ..., SpeechSynthesizer | TtsIncrementalText>

audio.pipe(Effect.provide(ElevenLabsLive)) // compiles
audio.pipe(Effect.provide(OpenAILive)) // type error: TtsIncrementalText not provided
```

**Two markers** cover the genuinely-rare hard gaps without cluttering common-case signatures:

| Marker               | Gates                     | Why marker-worthy                                                          |
| -------------------- | ------------------------- | -------------------------------------------------------------------------- |
| `TtsIncrementalText` | `streamSynthesisFrom`     | Rare — OpenAI, Azure (wire), AWS Polly non-Generative can't offer it.      |
| `SttStreaming`       | `streamTranscriptionFrom` | Rare-ish — Azure can't offer it at the wire level. Most STT providers can. |

**Methods without markers** (universal across providers that ship the service tag):

- `Transcriber.transcribe` — universal except AWS Transcribe, which emulates by draining a streaming session.
- `SpeechSynthesizer.synthesize` — universal.
- `SpeechSynthesizer.streamSynthesis` (chunked HTTP) — universal.

**Service-level gaps** (provider doesn't ship the tag at all):

- MiniMax — no STT → `@effect-uai/minimax` doesn't export a `Transcriber` Layer. Callers see `Transcriber` missing from R; no marker needed.
- Hume — no STT → same.

### Layer 2: request-data-dependent gaps → `AiError.Unsupported` (runtime)

Some gaps depend on values in the request itself, which can't be expressed in the type system without unwieldy template literal types or branded strings. These stay as runtime errors:

- **Google `streamSynthesisFrom`** works only for voice IDs matching `*-Chirp3-HD-*`. Same Layer, same provider — validity depends on `voiceId` string at runtime → `Unsupported` if the voice isn't Chirp 3 HD.
- **OpenAI `wordTimestamps`** requires `whisper-1` + `verbose_json`; using it on `gpt-4o-transcribe` → `Unsupported`.
- **MiniMax `subtitle_enable`** is restricted to `speech-01-*` models → `Unsupported` on others.

`AiError.Unsupported` is therefore narrower than originally planned — it fires only when request data makes a method invalid for the otherwise-supported provider, not for blanket provider-level gaps.

### Updated capability matrix

`Type` = compile-time R-channel marker. `Runtime` = `AiError.Unsupported` on call. `n/a` = service tag not provided.

| Provider                          | `transcribe`                                                              | `streamTranscriptionFrom`             | `synthesize` | `streamSynthesis`                                                                                    | `streamSynthesisFrom`                                                              |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| OpenAI                            | ok                                                                        | provides `SttStreaming` (Realtime WS) | ok           | ok (chunked HTTP)                                                                                    | **does not provide `TtsIncrementalText`**                                          |
| Google (Gemini API)               | ok (no word timestamps; `Unsupported` for `wordTimestamps`/`diarization`) | **does not provide `SttStreaming`**   | ok           | **does not provide** (Gemini TTS is sync-only — `streamSynthesis` is emulated by emitting one chunk) | **does not provide `TtsIncrementalText`**                                          |
| Google (Cloud Speech / TTS, gRPC) | ok                                                                        | provides `SttStreaming` (gRPC bidi)   | ok           | ok                                                                                                   | provides `TtsIncrementalText` — `Runtime Unsupported` if voiceId ≠ `*-Chirp3-HD-*` |
| ElevenLabs                        | ok                                                                        | provides `SttStreaming`               | ok           | ok                                                                                                   | provides `TtsIncrementalText`                                                      |
| Deepgram                          | ok                                                                        | provides `SttStreaming`               | ok           | ok                                                                                                   | provides `TtsIncrementalText`                                                      |
| Cartesia                          | (emulated)                                                                | provides `SttStreaming`               | ok           | ok                                                                                                   | provides `TtsIncrementalText`                                                      |
| Inworld                           | ok (`[docs unclear]`)                                                     | provides `SttStreaming`               | ok           | ok                                                                                                   | provides `TtsIncrementalText` (Realtime API protocol)                              |
| MiniMax                           | `Transcriber` n/a                                                         | `Transcriber` n/a                     | ok           | ok                                                                                                   | provides `TtsIncrementalText`                                                      |
| Azure                             | ok                                                                        | **does not provide `SttStreaming`**   | ok           | ok                                                                                                   | **does not provide `TtsIncrementalText`**                                          |
| AWS Transcribe                    | (emulated)                                                                | provides `SttStreaming`               | n/a          | n/a                                                                                                  | n/a                                                                                |
| AWS Polly                         | n/a                                                                       | n/a                                   | ok           | ok                                                                                                   | **does not provide `TtsIncrementalText`**                                          |
| Hume                              | `Transcriber` n/a                                                         | `Transcriber` n/a                     | ok           | ok                                                                                                   | provides `TtsIncrementalText`                                                      |

---

# Implementation plan

Order: providers that fit the existing HTTP-only mold first (OpenAI), then ElevenLabs (canonical streaming TTS), then Inworld + MiniMax (user-prioritized), then Deepgram + Cartesia (similar HTTP/WS shape), then Google via the Gemini REST API (cross-runtime, no gRPC), then Google Cloud Speech (gRPC, only for users who need streaming / word timestamps). Providers with unique wire mechanics (Azure SDK-only, AWS SigV4 + event-stream) are deferred.

## Package layout

| Package                           | Contents                                                                            | Status                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@effect-uai/responses`           | OpenAI Responses API (LLM, embeddings)                                              | unchanged                                                                                                                       |
| `@effect-uai/openai-speech`       | OpenAI STT, TTS                                                                     | **new** — separate from `responses` because `responses` is named after the Responses API protocol, not the provider             |
| `@effect-uai/google`              | Gemini LLM, embeddings, **Gemini speech (TTS + audio understanding via REST+JSON)** | extended — sync TTS + sync (prompt-based) STT via `generateContent`. No gRPC.                                                   |
| `@effect-uai/google-cloud-speech` | Google Cloud STT, Cloud TTS                                                         | **new** — depends on `@google-cloud/speech` and `@google-cloud/text-to-speech`. Adds streaming + word timestamps + diarization. |
| `@effect-uai/elevenlabs`          | ElevenLabs STT, TTS                                                                 | new                                                                                                                             |
| `@effect-uai/inworld`             | Inworld STT (pending docs verification), TTS                                        | new                                                                                                                             |
| `@effect-uai/minimax`             | MiniMax TTS (no STT — provider does not offer it)                                   | new                                                                                                                             |
| `@effect-uai/deepgram`            | Deepgram STT, TTS                                                                   | new                                                                                                                             |
| `@effect-uai/cartesia`            | Cartesia STT, TTS                                                                   | new                                                                                                                             |

Rationale for splitting OpenAI: `@effect-uai/responses` is named after OpenAI's _Responses API_ protocol (the `/v1/responses` endpoint plus the embeddings endpoint that shares its shape), not after the provider. OpenAI's audio endpoints (`/v1/audio/transcriptions`, `/v1/audio/speech`) have different request/response shapes and don't belong in a package named after a different API surface. They live in `@effect-uai/openai-speech` instead.

Rationale for splitting Google into two packages: the Gemini API exposes both TTS and audio understanding over REST+JSON ([speech-generation docs](https://ai.google.dev/gemini-api/docs/speech-generation), [audio docs](https://ai.google.dev/gemini-api/docs/audio)) — same transport stack as the existing Gemini adapter, so it folds into `@effect-uai/google` with **zero new deps**. The dedicated Cloud Speech / Cloud TTS APIs require gRPC (`@google-cloud/speech` → `google-gax` → `@grpc/grpc-js`, ~3 MB) but unlock streaming STT, streaming TTS, word timestamps, diarization, and SSML — features the Gemini API doesn't expose. Users who only need sync Google speech pay nothing for gRPC; users who need streaming opt into `@effect-uai/google-cloud-speech`.

## Runtime support note

`@grpc/grpc-js` (transitive dep of `@google-cloud/speech`) works on **Node ≥18, Bun ≥1.1, Deno ≥2**. It does not work in browsers, Cloudflare Workers, or Vercel Edge (no raw HTTP/2 client). All other provider packages — **including the Gemini-speech additions to `@effect-uai/google`** — remain HTTP/WebSocket only and run on every JS runtime.

## Phase 0 — Core abstraction (no provider code)

1. `packages/core/src/domain/Audio.ts` — `AudioMimeType`, `AudioSource`, `AudioFormat`, `AudioChunk`, `AudioBlob`, type guards.
2. `packages/core/src/domain/Transcript.ts` — `WordTimestamp`, `TranscriptResult`, `TranscriptEvent`, type guards.
3. `packages/core/src/domain/AiError.ts` — add `Unsupported` variant if not already present (for capability gaps).
4. `packages/core/src/transcriber/Transcriber.ts` — `Transcriber` service tag, `SttStreaming` capability marker, `CommonTranscribeRequest`, `CommonStreamTranscribeRequest`, top-level `transcribe` + dual-arity `streamTranscriptionFrom` (requires `SttStreaming` in R).
5. `packages/core/src/speech-synthesizer/SpeechSynthesizer.ts` — `SpeechSynthesizer` service tag, `TtsIncrementalText` capability marker, `CommonSynthesizeRequest`, `CommonStreamSynthesizeRequest`, top-level `synthesize` / `streamSynthesis` + dual-arity `streamSynthesisFrom` (requires `TtsIncrementalText` in R).
6. `packages/core/src/index.ts` — add exports `Audio`, `Transcript`, `Transcriber`, `SpeechSynthesizer`.
7. `packages/core/src/testing/` — mock `TranscriberLive` / `SpeechSynthesizerLive` layers that emit scripted events for use in recipe tests.

**Exit criteria**: types compile; mock layers pass a basic round-trip test (push 3 audio chunks, see 3 partials + 1 final).

## Phase 1 — OpenAI (new `@effect-uai/openai-speech` package)

Split from `@effect-uai/responses` (which is named after OpenAI's Responses API protocol, not the provider). The audio endpoints live in their own package so the Responses package stays focused on its protocol surface.

**1a — Sync STT + sync/streaming TTS (shipped):**

1. Package scaffold mirroring `@effect-uai/responses`.
2. `models.ts`: `OpenAITranscribeModel`, `OpenAITtsModel`, `OpenAIVoiceId` (stock-only — no `(string & {})` escape).
3. `codec.ts`: `audioToBlob` (Match over `AudioSource` variants; URL → `InvalidRequest`), `defaultFileName` (MIME → `audio.<ext>`), `containerToResponseFormat` / `realizedFormat` (Match), shared `httpStatusError` + `transportFailure` helpers.
4. `OpenAITranscriber.ts`
   - `transcribe`: `POST /v1/audio/transcriptions` (multipart). `wordTimestamps: true` requires `whisper-1` → fails `Unsupported` on GPT-4o models. `diarization: true` → `Unsupported`. Verbose JSON path returns per-word `WordTimestamp`s.
   - `streamTranscriptionFrom`: returns `Stream.fail(Unsupported)`. Layer **does not register `SttStreaming`** — callers get a compile-time error against this Layer alone.
5. `OpenAISynthesizer.ts`
   - `synthesize`: `POST /v1/audio/speech`. Buffers chunked response into `AudioBlob` (24 kHz fixed; `pcm` → `raw`+`pcm_s16le`).
   - `streamSynthesis`: same endpoint, surfaces raw bytes as `Stream<AudioChunk>` via `response.stream`.
   - `streamSynthesisFrom`: returns `Stream.fail(Unsupported)`. Layer **does not register `TtsIncrementalText`** — same compile-time gating.

**1b — Realtime WebSocket streaming (follow-up):**

1. Add `ws` peer dep + custom `WebSocketConstructor` Layer that supports headers (`Authorization: Bearer …` + `OpenAI-Beta: realtime=v1`).
2. Wire `streamTranscriptionFrom` to `wss://api.openai.com/v1/realtime?intent=transcription`: send `transcription_session.update` first frame; drain input audio as `input_audio_buffer.append` frames; decode server events to `TranscriptEvent` (`*.delta` → `partial`, `*.completed` → `final`, `speech_started`/`speech_stopped` → VAD events). Close WS via Scope finalizer.
3. Layer now also registers the `SttStreaming` capability marker.
4. Recipe: `recipes/streaming-transcription` (live mic → transcript).

**Phase 1a exit criteria**: end-to-end test against the live API using `OPENAI_API_KEY` (gated behind env var); sample WAV → transcript; sample text → mp3 bytes.

## Phase 2 — ElevenLabs (new `@effect-uai/elevenlabs` package)

Strongest fit for streaming TTS — canonical reference for the `streamSynthesisFrom` shape. New package.

1. Package scaffold: `package.json`, `tsconfig.json`, `src/index.ts` mirroring `@effect-uai/responses`.
2. `ElevenLabsTranscriber.ts`
   - `transcribe`: `POST /v1/speech-to-text` multipart. Map `prompt` → ignored (no biasing on Scribe v1).
   - `streamTranscriptionFrom`: scoped WS to `wss://api.elevenlabs.io/v1/speech-to-text/realtime`. Send query-param config at handshake; drain input audio stream as `input_audio_chunk` frames. Map events: `partial_transcript` → `partial`, `committed_transcript[_with_timestamps]` → `final`, `audio_event` → `audio-event`.
3. `ElevenLabsSynthesizer.ts`
   - `synthesize`: `POST /v1/text-to-speech/{voice_id}` JSON.
   - `streamSynthesis`: `POST /v1/text-to-speech/{voice_id}/stream`.
   - `streamSynthesisFrom`: scoped WS to `/v1/text-to-speech/{voice_id}/stream-input`. Send BOS frame (`text: " "` + voice_settings); drain input text stream as `{ text }` frames; on input-stream end send EOS `{ text: "" }` and drain remaining audio frames. WS closes via Scope finalizer.
4. `models.ts`: `ElevenLabsTtsModel`, `ElevenLabsSttModel`, `ElevenLabsVoiceId` (curated stock + `(string & {})`).
5. `codec.ts`: encode `output_format` query as compound slug (`mp3_44100_128`, etc.) from `AudioFormat`.
6. Auth: `xi-api-key` header.
7. Recipes: `recipes/incremental-tts` (LLM tokens → TTS audio via `streamSynthesisFrom`).

**Exit criteria**: piping `LanguageModel.streamTurn(...) |> Stream.filterMap(Turn.toTextDelta) |> ElevenLabs.streamSynthesisFrom(...)` produces continuous audio.

## Phase 3 — Inworld (new `@effect-uai/inworld` package)

Prioritized ahead of Deepgram and Cartesia. Inworld exposes an OpenAI-compatible HTTP endpoint plus a documented WebSocket TTS path. We ship a separate package (rather than reusing the OpenAI adapter behind a base-URL switch) to keep typed model/voice unions and provider-specific request extensions clean.

1. Package scaffold mirroring `@effect-uai/elevenlabs`.
2. `InworldTranscriber.ts`
   - **Caveat — verify before implementing**: Inworld's STT model name (`realtime-stt-1` per earlier research) and exact endpoint shape are thinly documented. First task in this phase is to confirm against the live docs / SDK before writing code. If the STT surface is unstable, ship TTS-only for v1 and revisit.
   - `transcribe`: REST endpoint (HTTP).
   - `streamTranscriptionFrom`: scoped WebSocket.
3. `InworldSynthesizer.ts`
   - `synthesize`: REST `POST` (sync). Body shape OpenAI-compatible — can reuse codec helpers from `@effect-uai/responses` if the field set matches exactly.
   - `streamSynthesis`: chunked HTTP variant.
   - `streamSynthesisFrom`: scoped WebSocket with low first-token latency. Drain input text stream as text frames per Inworld's framing spec.
4. `models.ts`: `InworldTtsModel` (`realtime-tts-2`, `realtime-tts-1.5`, `realtime-tts-1.5-max`, `inworld-tts-1`, `inworld-tts-1-max`), `InworldVoiceId` (curated stock + `(string & {})` for clones).
5. Auth: bearer token via Inworld API key.
6. Recipe: incremental TTS comparison with ElevenLabs (latency/voice-quality side-by-side).

**Exit criteria**: TTS sync + streaming + streamSynthesisFrom green. STT lands if docs verify clean; otherwise tracked as a follow-up.

## Phase 4 — MiniMax (new `@effect-uai/minimax` package, TTS only)

Prioritized ahead of Deepgram and Cartesia. **No first-party STT API** — this package ships TTS only. **No official TypeScript SDK** — we handcraft HTTP/WS clients.

1. Package scaffold. No SDK dependency; uses Effect's HTTP client + WebSocket primitives.
2. `MiniMaxSynthesizer.ts`
   - `synthesize`: `POST https://api.minimax.io/v1/t2a_v2` (JSON, up to 10K chars). Decode response audio bytes to `AudioBlob`.
   - `streamSynthesis`: same endpoint with `stream=true` (chunked HTTP).
   - `streamSynthesisFrom`: scoped WebSocket at `/ws/v1/t2a_v2`. Drain input text stream as text frames per MiniMax's framing spec.
3. `models.ts`: `MiniMaxTtsModel` (`speech-02-hd`, `speech-02-turbo`, `speech-2.6-turbo`), `MiniMaxVoiceId` (curated subset of the ~300 stock voices — Chinese-strong — plus `(string & {})` for clones).
4. `codec.ts`: assemble output-format object from `AudioFormat` (mp3/pcm/flac/wav at 8–44 kHz).
5. Auth: bearer token. Note: MiniMax has separate Chinese-mainland and international endpoints — package config takes a `baseUrl` to switch between them.
6. `Transcriber` service: not implemented — package does not provide it.

**Exit criteria**: TTS sync + streaming + streamSynthesisFrom green against MiniMax's international endpoint.

## Phase 5 — Deepgram + Cartesia (new packages, parallel-friendly)

Both have clean WS shapes that mirror Phase 2. Implement in parallel or sequentially; neither blocks the other.

### `@effect-uai/deepgram`

1. `DeepgramTranscriber.ts`
   - `transcribe`: `POST /v1/listen` raw bytes or URL body. Map `prompt.terms` → `keyterm[]` query params.
   - `streamTranscriptionFrom`: scoped WS to `/v1/listen` with same query params + `interim_results=true`. Drain input audio stream as binary frames. Map `is_final`/`speech_final`/`SpeechStarted`/`UtteranceEnd` to common events. Send `{type:"CloseStream"}` for graceful close in the Scope finalizer.
2. `DeepgramSynthesizer.ts`
   - `synthesize` / `streamSynthesis`: `POST /v1/speak`. Voice ID is wedged into `model` slug (`aura-2-thalia-en`) — adapter assembles from `model + voiceId`.
   - `streamSynthesisFrom`: scoped WS `/v1/speak`. Drain input text stream as `{type:"Speak", text}` frames; on input-stream end send `{type:"Flush"}` then `{type:"Close"}` via the Scope finalizer.
3. Recipe: a Deepgram-vs-OpenAI side-by-side STT recipe.

### `@effect-uai/cartesia`

1. `CartesiaTranscriber.ts` — WS-only Ink-Whisper. `transcribe` emulated by running `streamTranscriptionFrom` over a single-chunk input stream and folding to the first `final` event.
2. `CartesiaSynthesizer.ts` — `POST /tts/bytes` for sync; WS `/tts/websocket` for both `streamSynthesis` and `streamSynthesisFrom`. Single fixed `context_id` per call for the common shape; multi-context exposed as `cartesia.forkContext` provider extension.
3. Auth: `X-API-Key` + `Cartesia-Version` (pin to a dated version in the package — `2025-04-16` at writing).

**Exit criteria**: cross-provider switch test passes — same input audio → similar transcript across OpenAI / ElevenLabs / Deepgram / Cartesia.

## Phase 6 — Google

Split into two sub-phases because the Gemini REST API and the Cloud Speech gRPC API have radically different transport stacks. The Gemini path ships first (HTTP, every runtime, zero new deps) and covers the common case; the Cloud Speech path follows when users need features the Gemini API can't expose.

### Phase 6a — Gemini speech (extend `@effect-uai/google`)

Folded into the existing Gemini package — same `generateContent` endpoint family, same auth, same `HttpClient` Layer. No package split needed.

1. `models.ts` additions: `GeminiTtsModel` (`gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`, `gemini-3.1-flash-tts-preview`), `GeminiSttModel` (`gemini-3-flash-preview` and other audio-capable Gemini models), `GeminiVoiceName` (`Kore`, `Puck`, `Zephyr`, `Enceladus`, …).
2. `GeminiSynthesizer.ts`
   - `synthesize`: `POST /v1beta/models/{model}:generateContent` with `generationConfig.responseModalities: ["AUDIO"]` and `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. Multi-speaker via `multiSpeakerVoiceConfig.speakerVoiceConfigs[]` when `request.speakers` is provided. Decode base64 PCM from `candidates[0].content.parts[0].inlineData.data` → `AudioBlob` (24 kHz mono, raw `pcm_s16le`).
   - `streamSynthesis`: emulated — calls `synthesize`, emits the result as a single `AudioChunk`. Gemini TTS has no chunked-streaming endpoint.
   - `streamSynthesisFrom`: `Stream.fail(Unsupported)`. Layer **does not register `TtsIncrementalText`**.
3. `GeminiTranscriber.ts`
   - `transcribe`: `POST /v1beta/models/{model}:generateContent` with the audio as `inlineData` (≤20 MB) or via Files API URI. Prompt: `"Transcribe this audio verbatim. Return only the transcript text."` Parse `candidates[0].content.parts[0].text` → `TranscriptResult { text }`. No word timestamps. `wordTimestamps: true` or `diarization: true` → `Unsupported`.
   - `streamTranscriptionFrom`: `Stream.fail(Unsupported)`. Layer **does not register `SttStreaming`**.
4. Codec helpers in `codec.ts`: `audioSourceToInlineData` (Match over `AudioSource` variants; URL → `InvalidRequest` for inline path; Files API path lives as a separate `audioSourceToFileData` if/when we wire Files upload).
5. Auth: reuses `@effect-uai/google` `apiKey` / `x-goog-api-key` header logic.
6. Recipe: Gemini variants of `basic-transcription` and `basic-speech-synthesis` recipes (or extend existing recipes with a provider switch).

**Exit criteria**: Gemini TTS round-trip writes a valid WAV from a 24 kHz PCM blob; Gemini transcription returns the expected text on a known sample; compile-time gating proves `streamSynthesisFrom` / `streamTranscriptionFrom` against the Gemini Layer alone is a type error.

### Phase 6b — Google Cloud Speech (new `@effect-uai/google-cloud-speech` package)

For users who need streaming STT, streaming TTS, or word-level timestamps. Built on `@google-cloud/speech` + `@google-cloud/text-to-speech` rather than raw `@grpc/grpc-js` — the SDKs ship generated proto types, ADC handling, and retry logic, and have the same runtime constraints as raw grpc-js anyway.

1. Package scaffold: `package.json`, `tsconfig.json`, `src/index.ts`. Dependencies: `@google-cloud/speech`, `@google-cloud/text-to-speech`, `effect`, `@effect-uai/core`.
2. `GoogleCloudTranscriber.ts`
   - `transcribe`: `SpeechClient.recognize({ config, content | uri })`. Map `prompt.terms` → `config.adaptation.phraseSets[].inlinePhraseSet.phrases[]`. Parse `"1.200s"` duration strings into seconds.
   - `streamTranscriptionFrom`: returned `Stream` wraps `SpeechClient.streamingRecognize()` in `Stream.scoped`. Send `streamingConfig` first; drain the input audio stream into the SDK's writable side as `{ audioContent: bytes }`. Pump SDK events → `TranscriptEvent` (`isFinal=false` → `partial` with `stability`, `isFinal=true` → `final`, `speechEventType` → `speech-started` / `utterance-ended`).
3. `GoogleCloudSynthesizer.ts`
   - `synthesize`: `TextToSpeechClient.synthesizeSpeech({ input, voice, audioConfig })`. Decode base64 `audioContent` → `AudioBlob`.
   - `streamSynthesis`: same call; surface chunks as `Stream<AudioChunk>`.
   - `streamSynthesisFrom`: wraps `TextToSpeechClient.streamingSynthesize()` in `Stream.scoped`. Chirp 3 HD voices only — validate `voiceId` matches `*-Chirp3-HD-*`; emit `Unsupported` on the output stream otherwise. First SDK message = `streaming_config`; drain input text stream as `{ input: { text } }` messages. SDK half-close on input-stream end.
4. `models.ts`: `GoogleSttModel`, `GoogleTtsVoiceId` (curated Chirp 3 HD + Neural2 + Studio + Standard voices, plus `(string & {})` for custom voices).
5. `codec.ts`: translate between common types and SDK types (`AudioFormat` ↔ `audioEncoding` + `sampleRateHertz`; duration strings → seconds; `voice.name` ↔ `voiceId`).
6. Auth: ADC via `google-auth-library` (handled inside the SDK — `GOOGLE_APPLICATION_CREDENTIALS`, metadata server on GCE/Cloud Run, gcloud CLI on dev).
7. Recipe parity with Phase 1.

**Exit criteria**: all methods green on Node, Bun, and Deno (runtime test matrix) using a service-account credential.

## Phase 7 (deferred) — providers with unique wire mechanics

Each of these costs more than a Phase-2-style adapter. Defer until a user requests them.

- **Azure Speech** — streaming is SDK-internal (not documented at the wire level). Either vendor `microsoft-cognitiveservices-speech-sdk` as a peer dep (Node-only), or ship sync-only and document `Unsupported`.
- **AWS Polly + Transcribe** — SigV4 signing is non-trivial; Transcribe uses AWS event-stream binary framing. Likely vendor `@aws-sdk/client-polly` and `@aws-sdk/client-transcribe-streaming` rather than re-implement.
- **AssemblyAI** — session-duration billing on streaming (idle WS counts) is an operational footgun worth surfacing in provider metadata before exposing.
- **Hume Octave** — small surface, low priority unless emotion-controlled TTS becomes a request.

## Open questions to resolve before Phase 0

1. **`AiError.Unsupported`** — does not exist today (only 10 variants in [packages/core/src/domain/AiError.ts](packages/core/src/domain/AiError.ts): `RateLimited`, `Unavailable`, `Timeout`, `ContentFiltered`, `ContextLengthExceeded`, `InvalidRequest`, `AuthFailed`, `Cancelled`, `GenerationFailed`, `IncompleteTurn`). Need to add it. Proposed: `Data.TaggedError("Unsupported")<{ provider: string; capability: string; reason?: string }>`.
2. **Audio MIME literal scope** — is the proposed `AudioMimeType` set complete for v1, or do we want to keep `(string & {})` and add literals as providers need them?

## Resolved decisions

- **Two services, capability gaps surface as `Unsupported` errors** rather than splitting into more granular service tags. Provider feature sets evolve (AWS Polly just added bidirectional streaming in March 2026) — modeling availability at runtime in the error channel beats churning the type surface every time a provider adds an endpoint.
- **Google split into two paths**:
  - **Gemini speech (REST + JSON) folds into `@effect-uai/google`** — same transport stack as the existing Gemini adapter, zero new deps, runs on every JS runtime. Covers sync TTS and prompt-based transcription. Layer does not provide `SttStreaming` / `TtsIncrementalText`, and `wordTimestamps`/`diarization` on `transcribe` → `Unsupported` (Gemini doesn't expose them).
  - **Cloud Speech (gRPC) lives in `@effect-uai/google-cloud-speech`** — built on the official `@google-cloud/speech` and `@google-cloud/text-to-speech` SDKs, not raw `@grpc/grpc-js`. Adds the streaming/word-timestamp/diarization features the Gemini path can't. Optional, opt-in dependency.

## Out of scope for this plan

- Realtime speech-to-speech (`RealtimeSession` — separate work). Will reuse `Audio.ts` and `Transcript.ts` domain types but is expected to need a richer shape than `Stream → Stream` because duplex requires sideband control (interrupt, mid-stream config, VAD tuning). Shape parity with `Transcriber` / `SpeechSynthesizer` is not required.
- Voice cloning creation APIs.
- Audio pre/post processing (resampling, format conversion, VAD on the client side).
- Browser-only transports (WebRTC for OpenAI Realtime, MediaRecorder integration).
