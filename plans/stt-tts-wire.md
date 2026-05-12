# Speech Provider — Wire-Level API Shapes

Companion to `stt-tts.md`. Compiled 2026-05-11. TypeScript pseudocode shows the wire shape (HTTP body, WS frame, gRPC message), not the SDK surface.

Coverage tiers (per request):
- Heavy: OpenAI, Google Cloud, ElevenLabs.
- Medium: Deepgram, Cartesia.
- Light: Azure, AWS Polly + Transcribe.

Each provider section gives, where applicable: **Sync request/response**, **Streaming wire**, **TTS specifics**, **Auth**, and **Fit notes** flagging which `CommonTranscribeRequest`/`CommonSynthesizeRequest` fields map natively.

Note: parts of the official OpenAI and ElevenLabs doc sites returned 403/permission-denied to direct fetch; those sections rely on web search results pointing at the same official URLs. Wherever a field could not be confirmed from a citable source the comment is `[docs unclear]`.

---

## OpenAI STT

Sources: [Create transcription (developers.openai.com)](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create), [Speech to text guide](https://platform.openai.com/docs/guides/speech-to-text), [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription), [Realtime client events — input_audio_buffer.append](https://platform.openai.com/docs/api-reference/realtime-client-events/input_audio_buffer/append).

### Sync request shape — `POST https://api.openai.com/v1/audio/transcriptions`

`multipart/form-data` (file upload).

```ts
type OpenAITranscribeRequest = {
  file: Blob | ReadableStream         // m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
  model: "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "whisper-1"
  language?: string                   // ISO-639-1, e.g. "en"
  prompt?: string                     // ≤224-token style/vocab hint
  response_format?:
    | "json"                          // default; only format on gpt-4o-(mini-)transcribe
    | "text"                          // whisper-1 only
    | "srt" | "vtt"                   // whisper-1 only
    | "verbose_json"                  // whisper-1 only — required for timestamp_granularities
  temperature?: number                // 0..1
  timestamp_granularities?: Array<"word" | "segment">  // verbose_json + whisper-1 only
  stream?: boolean                    // gpt-4o-(mini-)transcribe only (NOT whisper-1)
  include?: Array<"logprobs">         // gpt-4o-(mini-)transcribe only
  chunking_strategy?: "auto" | { type: "server_vad", prefix_padding_ms?: number, silence_duration_ms?: number, threshold?: number }
}

type OpenAITranscribeResponseJson = { text: string }

// whisper-1 + verbose_json
type OpenAITranscribeResponseVerbose = {
  task: "transcribe"
  language: string
  duration: number                    // seconds
  text: string
  words?: Array<{ word: string, start: number, end: number }>
  segments?: Array<{
    id: number
    seek: number
    start: number; end: number        // seconds
    text: string
    tokens: number[]
    temperature: number
    avg_logprob: number
    compression_ratio: number
    no_speech_prob: number
  }>
}
```

### Streaming wire (HTTP SSE on `/v1/audio/transcriptions` with `stream=true`)

`gpt-4o-transcribe` / `gpt-4o-mini-transcribe` only. The response is `text/event-stream`.

```ts
type OpenAITranscribeStreamEvent =
  | { type: "transcript.text.delta", delta: string, logprobs?: Array<{ token: string, logprob: number, bytes: number[] }> }
  | { type: "transcript.text.done",  text: string, logprobs?: unknown[] }
```

### Streaming wire (WebSocket Realtime, transcription-only intent)

```ts
const url = "wss://api.openai.com/v1/realtime?intent=transcription"
// Headers:
//   Authorization: Bearer ${OPENAI_API_KEY}
//   OpenAI-Beta: realtime=v1

// Client → server events:
type OAClientEvent =
  | { type: "transcription_session.update", session: {
        input_audio_format: "pcm16" | "g711_ulaw" | "g711_alaw"
        input_audio_transcription?: { model: "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "whisper-1", language?: string, prompt?: string }
        turn_detection?: null | { type: "server_vad", threshold?: number, prefix_padding_ms?: number, silence_duration_ms?: number } | { type: "semantic_vad", eagerness?: "low" | "medium" | "high" | "auto" }
        input_audio_noise_reduction?: null | { type: "near_field" | "far_field" }
        include?: Array<"item.input_audio_transcription.logprobs">
      } }
  | { type: "input_audio_buffer.append", audio: string /* base64 PCM/μ-law */, event_id?: string }
  | { type: "input_audio_buffer.commit" }
  | { type: "input_audio_buffer.clear" }

// Server → client events (selected — transcription-relevant):
type OAServerEvent =
  | { type: "transcription_session.created" | "transcription_session.updated", session: unknown }
  | { type: "input_audio_buffer.speech_started", item_id: string, audio_start_ms: number }
  | { type: "input_audio_buffer.speech_stopped", item_id: string, audio_end_ms: number }
  | { type: "input_audio_buffer.committed", item_id: string, previous_item_id: string | null }
  | { type: "conversation.item.input_audio_transcription.delta",     item_id: string, content_index: number, delta: string, logprobs?: unknown[] }
  | { type: "conversation.item.input_audio_transcription.completed", item_id: string, content_index: number, transcript: string, logprobs?: unknown[] }
  | { type: "conversation.item.input_audio_transcription.failed",    item_id: string, content_index: number, error: { type: string, code?: string, message: string, param?: string } }
  | { type: "error", error: { type: string, code?: string, message: string, event_id?: string, param?: string } }
```

Close mechanics: client closes the WebSocket. There is no application-level "close stream" message — VAD-driven commits create per-utterance items; final close is the TCP close.

### Auth
`Authorization: Bearer ${OPENAI_API_KEY}` (REST + WS); WS additionally requires `OpenAI-Beta: realtime=v1`.

### Fit notes
- `CommonTranscribeRequest`: native — `model`, `audio`(file), `language`, `prompt`. Missing native — URL-mode audio input (must be uploaded as file).
- gpt-4o-transcribe streaming has **delta-text** event shape only; per-word timestamps are whisper-1-and-verbose_json only — divergent from Google/Deepgram which emit per-word in streaming too.
- Session fits the `Queue<AudioChunk>` + `Stream<TranscriptEvent>` shape cleanly.

---

## OpenAI TTS

Sources: [Create speech reference](https://platform.openai.com/docs/api-reference/audio/createSpeech), [Text to speech guide](https://platform.openai.com/docs/guides/text-to-speech).

### Sync request shape — `POST https://api.openai.com/v1/audio/speech`

`application/json`. The response body is raw audio bytes (or SSE frames if `stream_format=sse`).

```ts
type OpenAISpeechRequest = {
  model: "gpt-4o-mini-tts" | "tts-1" | "tts-1-hd"
  input: string                       // up to 4096 chars
  voice:
    | "alloy" | "ash" | "ballad" | "coral" | "echo"
    | "fable" | "onyx" | "nova" | "sage" | "shimmer" | "verse"  // gpt-4o-mini-tts adds ballad/coral/verse
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm"  // default "mp3"; pcm is 24kHz s16le mono
  speed?: number                      // 0.25..4.0, default 1.0
  instructions?: string               // gpt-4o-mini-tts only — free-form tone/emotion/pacing
  stream_format?: "sse" | "audio"     // gpt-4o-mini-tts only; "sse" emits delta events
}

// Response when stream_format omitted/="audio": HTTP body = raw audio bytes.
// Response when stream_format="sse": text/event-stream with:
type OpenAISpeechStreamEvent =
  | { type: "speech.audio.delta", audio: string /* base64 chunk */ }
  | { type: "speech.audio.done",  usage?: { input_tokens: number, output_tokens: number, total_tokens: number } }
```

There is **no WebSocket / incremental-text-in TTS endpoint** for OpenAI. Audio is streamed via chunked HTTP only; the *prompt* is fully buffered before the call.

### Auth
`Authorization: Bearer ${OPENAI_API_KEY}`.

### Fit notes
- `CommonSynthesizeRequest`: native — `model`, `text`(=input), `voiceId`(slug), `outputFormat`, `speed`. Maps cleanly. No `pitch`, no `volume`, no `style` (collapsed into `instructions` free-text).
- **No `openSynthesisSession`** — throw `Unsupported`. The `streamSynthesis(req): Stream<AudioChunk>` shape works via chunked HTTP.

---

## Google Cloud STT

Sources: [recognize REST reference](https://docs.cloud.google.com/speech-to-text/v2/docs/reference/rest/v2/projects.locations.recognizers/recognize), [StreamingRecognize gRPC reference](https://docs.cloud.google.com/speech-to-text/v2/docs/reference/rpc/google.cloud.speech.v2).

### Sync request shape — `POST https://speech.googleapis.com/v2/{recognizer=projects/*/locations/*/recognizers/*}:recognize`

```ts
type GoogleRecognitionConfig = {
  model?: "chirp_2" | "chirp" | "long" | "short" | "telephony" | string  // "_" or explicit model id
  languageCodes: string[]              // BCP-47, e.g. ["en-US"]; "auto" for detection on chirp_2
  features?: {
    profanityFilter?: boolean
    enableWordTimeOffsets?: boolean
    enableWordConfidence?: boolean
    enableAutomaticPunctuation?: boolean
    enableSpokenPunctuation?: boolean
    enableSpokenEmojis?: boolean
    multiChannelMode?: "MULTI_CHANNEL_MODE_UNSPECIFIED" | "SEPARATE_RECOGNITION_PER_CHANNEL"
    diarizationConfig?: { minSpeakerCount?: number, maxSpeakerCount?: number }
    maxAlternatives?: number
  }
  adaptation?: {
    phraseSets?: Array<{ inlinePhraseSet: { phrases: Array<{ value: string, boost?: number }>, boost?: number } } | { phraseSet: string /* resource name */ }>
    customClasses?: unknown[]
  }
  // exactly one of autoDecodingConfig | explicitDecodingConfig
  autoDecodingConfig?: {}
  explicitDecodingConfig?: { encoding: "LINEAR16"|"MULAW"|"ALAW", sampleRateHertz: number, audioChannelCount?: number }
  transcriptNormalization?: { entries: Array<{ search: string, replace: string, caseSensitive?: boolean }> }
  translationConfig?: { targetLanguage: string }
}

type GoogleRecognizeRequest = {
  config?: GoogleRecognitionConfig    // can be omitted if recognizer has defaults
  configMask?: string                 // FieldMask
  // oneof:
  content?: string                    // base64 audio bytes
  uri?: string                        // gs://bucket/object
}

type GoogleRecognizeResponse = {
  results: Array<{
    alternatives: Array<{
      transcript: string
      confidence: number
      words?: Array<{ startOffset: string /* "1.200s" */, endOffset: string, word: string, confidence?: number, speakerLabel?: string }>
    }>
    channelTag?: number
    resultEndOffset: string
    languageCode?: string
  }>
  metadata: { requestId: string, totalBilledDuration: string /* "12.5s" */ }
}
```

### Streaming wire — gRPC bidirectional `google.cloud.speech.v2.Speech/StreamingRecognize`

```ts
// Conceptual (Protobuf oneof; not a REST/JSON path)
type GoogleStreamingRecognizeRequest =
  | { streaming_config: {
        config: GoogleRecognitionConfig
        config_mask?: string
        streaming_features?: {
          interim_results?: boolean
          enable_voice_activity_events?: boolean
          voice_activity_timeout?: { speech_start_timeout?: string, speech_end_timeout?: string }
        }
        recognizer?: string
      } }
  | { audio: Uint8Array }              // subsequent messages — raw audio bytes per `explicitDecodingConfig`

type GoogleStreamingRecognizeResponse = {
  results: Array<{
    alternatives: Array<{ transcript: string, confidence: number, words?: Array<{ startOffset: string, endOffset: string, word: string }> }>
    isFinal: boolean
    stability: number                  // 0..1, interim only
    resultEndOffset: string
    channelTag?: number
    languageCode?: string
  }>
  speechEventType?: "SPEECH_EVENT_TYPE_UNSPECIFIED" | "END_OF_SINGLE_UTTERANCE" | "SPEECH_ACTIVITY_BEGIN" | "SPEECH_ACTIVITY_END"
  speechEventOffset?: string
  metadata: { totalBilledDuration: string, requestId: string }
}
```

Close mechanics: client half-closes the gRPC stream (`call.end()`); server flushes final results and closes.

### Auth
OAuth2 access token (`Authorization: Bearer …`) from a Google service account with scope `https://www.googleapis.com/auth/cloud-platform`, or ADC. No simple API-key path.

### Fit notes
- `CommonTranscribeRequest`: native — `model`, `audio`(content or gs:// URI), `language`(`languageCodes[0]`), and `prompt` maps via `adaptation.phraseSets.inlinePhraseSet.phrases[].value` (richer than a single prompt string).
- Streaming is **gRPC only** — REST/WS-only consumers must use a gRPC-over-HTTP/2 client. Wraps cleanly into `Queue<bytes>` + `Stream<TranscriptEvent>`.
- Time offsets are `Duration` strings (`"1.200s"`) — must parse to seconds for the common shape.

---

## Google Cloud TTS

Sources: [text:synthesize REST](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize), [Chirp 3 HD streaming](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd).

### Sync request shape — `POST https://texttospeech.googleapis.com/v1/text:synthesize`

```ts
type GoogleSynthesizeRequest = {
  input:                              // SynthesisInput, oneof
    | { text: string }
    | { ssml: string }
    | { markup: string }              // Chirp 3 HD: pause control via inline tags
  voice: {
    languageCode: string              // "en-US"
    name?: string                     // e.g. "en-US-Chirp3-HD-Aoede" — fully identifies the voice
    ssmlGender?: "MALE" | "FEMALE" | "NEUTRAL" | "SSML_VOICE_GENDER_UNSPECIFIED"
    customVoice?: { model: string, reportedUsage?: "REALTIME" | "OFFLINE" }
    voiceClone?: { voiceCloningKey: string }
  }
  audioConfig: {
    audioEncoding: "LINEAR16" | "MP3" | "OGG_OPUS" | "MULAW" | "ALAW" | "PCM"
    sampleRateHertz?: number          // 8000/16000/22050/24000/44100/48000 depending on voice
    speakingRate?: number             // 0.25..4.0
    pitch?: number                    // -20..20 semitones — NOT supported on Chirp 3 HD
    volumeGainDb?: number             // -96..16
    effectsProfileId?: string[]       // device profile slugs
  }
  advancedVoiceOptions?: { lowLatencyJourneySynthesis?: boolean }
}

type GoogleSynthesizeResponse = {
  audioContent: string                // base64 of audio (with container if MP3/OGG)
}
```

### Streaming wire — gRPC bidirectional `texttospeech.googleapis.com/v1beta1` `StreamingSynthesize` (Chirp 3 HD only)

```ts
type GoogleStreamingSynthesizeRequest =
  | { streaming_config: {
        voice: { languageCode: string, name: string /* e.g. en-US-Chirp3-HD-Aoede */ }
        streaming_audio_config: { audio_encoding: "PCM" | "OGG_OPUS" | "MULAW" | "ALAW", sample_rate_hertz?: number }
      } }                              // first request — config only
  | { input: { text: string } }       // subsequent — text chunks; client iterator/end-of-stream = "no more text"

type GoogleStreamingSynthesizeResponse = {
  audio_content: Uint8Array            // chunk; no `done` flag — stream EOF is end of audio
}
```

End-of-input mechanics: half-close the gRPC stream from the client; the server finishes synthesizing buffered text and closes. `[docs unclear]` on whether mid-stream "flush now" is supported separately from EOF.

### Auth
OAuth2 / ADC (`Authorization: Bearer …`).

### Fit notes
- `CommonSynthesizeRequest`: native — `model`(implicit via voice `name`), `text`, `voiceId`(=`voice.name`), `outputFormat`, `speed`(=`speakingRate`). `pitch` and `volumeGainDb` are extras.
- Streaming-text-in **only on Chirp 3 HD voices** — other Google engines support audio streaming (chunked HTTP) but not incremental text. The session shape is `openSynthesisSession`-compatible only when voice name matches `*-Chirp3-HD-*`.
- gRPC transport — same caveat as STT.

---

## ElevenLabs STT

Sources: [Create transcript reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [Realtime STT reference](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime), [Transcripts and commit strategies](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/speech-to-text/realtime/transcripts-and-commit-strategies).

### Sync request shape — `POST https://api.elevenlabs.io/v1/speech-to-text`

`multipart/form-data`.

```ts
type ElevenScribeRequest = {
  model_id: "scribe_v1" | "scribe_v1_experimental"   // scribe_v2_realtime is WS-only
  file?: Blob                                         // up to ~3GB
  cloud_storage_url?: string                          // HTTPS-fetched alternative
  language_code?: string                              // ISO-639-1; omit for autodetect
  tag_audio_events?: boolean                          // default true; emits "audio_event" word entries
  num_speakers?: number                               // 1..32 (helps diarization)
  diarize?: boolean
  diarization_threshold?: number                      // 0.1..0.4
  detect_speaker_roles?: boolean                      // speaker_id becomes "agent"|"customer"
  timestamps_granularity?: "none" | "word" | "character"
  webhook?: boolean
  additional_formats?: Array<"srt"|"vtt"|"docx"|"pdf"|"html"|"txt">
  enable_logging?: boolean
}

type ElevenScribeResponse = {
  language_code: string
  language_probability: number
  text: string
  words: Array<{
    text: string
    type: "word" | "spacing" | "audio_event"          // audio_event examples: "(laughter)", "(music)"
    start: number; end: number                        // seconds
    speaker_id?: string                               // "speaker_0"... or "agent"/"customer"
    characters?: Array<{ text: string, start: number, end: number }>   // when granularity="character"
    logprob?: number
  }>
  additional_formats?: Array<{ requested_format: string, file_extension: string, content_type: string, is_base64_encoded: boolean, content: string }>
}
```

### Streaming wire — `wss://api.elevenlabs.io/v1/speech-to-text/realtime`

Query params: `model_id` (`scribe_v2_realtime`), `language_code?`, `encoding?` (e.g. `pcm_16000`), `tag_audio_events?`, plus any commit-strategy params.

```ts
// Client → server messages (JSON frames):
type ElevenSttClient =
  | { type: "input_audio_chunk", audio: string /* base64-PCM */, commit?: boolean }
  // Empty audio with commit:true is the conventional flush/EOU signal.
  // [docs unclear] on whether a separate config message is needed; defaults come from query params.

// Server → client messages:
type ElevenSttServer =
  | { type: "session_started", session_id: string, model_id: "scribe_v2_realtime", config?: unknown }
  | { type: "partial_transcript",  text: string, /* [docs unclear: words?] */ }
  | { type: "committed_transcript", text: string, language_code?: string }
  | { type: "committed_transcript_with_timestamps", text: string, words: Array<{ text: string, start: number, end: number, speaker_id?: string }> }
  | { type: "audio_event", text: string /* e.g. "(laughter)" */, start: number, end: number }
  | { type: "error", code?: string, message: string }
```

Close mechanics: standard WebSocket close (`code=1000`). To flush a final transcript, send `{ type: "input_audio_chunk", audio: "", commit: true }` *before* closing.

### Auth
Header `xi-api-key: ${ELEVENLABS_API_KEY}` (REST). For WebSockets, the same header at handshake, or query param `?xi_api_key=…` `[docs unclear]` (the realtime page documents header auth).

### Fit notes
- `CommonTranscribeRequest`: native — `model`, `audio`(file or URL), `language`. `prompt` (vocab biasing) **not exposed** on Scribe v1 sync — extension only.
- Streaming session fits `Queue<AudioChunk>` + `Stream<TranscriptEvent>`. Notable: partial → committed transition is **explicit (commit message or VAD)** — closer to Deepgram's `is_final` semantics than Google's stability score. Three distinct event shapes (partial / committed / committed-with-timestamps) — collapse to two in the common surface.

---

## ElevenLabs TTS

Sources: [Convert (sync)](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [WebSocket stream-input reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input), [Real-time WS guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts), [Multi-context WS](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input).

### Sync request shape — `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` (and `/stream`)

`application/json`. The `/stream` variant returns chunked audio; both share the body schema.

```ts
type ElevenSpeechRequest = {
  text: string
  model_id?: "eleven_v3" | "eleven_multilingual_v2" | "eleven_turbo_v2_5" | "eleven_flash_v2_5" | string
  language_code?: string                               // ISO-639-1; Flash/Turbo only enforce
  voice_settings?: {
    stability: number                                  // 0..1
    similarity_boost: number                           // 0..1
    style?: number                                     // 0..1; multilingual_v2/v3
    use_speaker_boost?: boolean
    speed?: number                                     // 0.7..1.2
  }
  pronunciation_dictionary_locators?: Array<{ pronunciation_dictionary_id: string, version_id: string }>
  seed?: number                                        // 0..4294967295
  previous_text?: string; next_text?: string           // continuity hints
  previous_request_ids?: string[]; next_request_ids?: string[]
  apply_text_normalization?: "auto" | "on" | "off"
  apply_language_text_normalization?: boolean
}
// Voice ID is in the URL path (20-char alphanum or 32-char hex).
// Query param: output_format — one of:
//   mp3_22050_32 mp3_44100_32 mp3_44100_64 mp3_44100_96 mp3_44100_128 mp3_44100_192
//   pcm_8000 pcm_16000 pcm_22050 pcm_24000 pcm_44100 pcm_48000
//   ulaw_8000 alaw_8000
//   opus_48000_32 opus_48000_64 opus_48000_96 opus_48000_128 opus_48000_192

// Response: raw audio bytes (Content-Type per format).

// /with-timestamps variant returns JSON:
type ElevenSpeechWithTimestampsResponse = {
  audio_base64: string
  alignment:           { characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }
  normalized_alignment:{ characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }
}
```

### Streaming TTS via WebSocket — `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`

Query params: `model_id`, `output_format`, `optimize_streaming_latency` (`0..4` deprecated, prefer `auto_mode`), `inactivity_timeout` (seconds, ≤20), `sync_alignment` (bool), `enable_logging`, `language_code`, `auto_mode` (bool — disables forced chunk schedule).

```ts
// 1) Beginning-of-Stream initial frame (auth + config):
type ElevenWsBOS = {
  text: " "                                            // single-space sentinel
  voice_settings?: { stability?: number, similarity_boost?: number, style?: number, use_speaker_boost?: boolean, speed?: number }
  generation_config?: {
    chunk_length_schedule?: number[]                   // e.g. [120,160,250,290] — chars before each generation
  }
  pronunciation_dictionary_locators?: Array<{ pronunciation_dictionary_id: string, version_id: string }>
  xi_api_key?: string                                  // alternative to header
  authorization?: string                               // OAuth-style; rarely used
}

// 2) Subsequent text frames — text appended; may force generation:
type ElevenWsText = {
  text: string                                         // partial text; must end with " " for word boundary
  try_trigger_generation?: boolean                     // legacy
  flush?: boolean                                      // force-emit current buffer immediately
  generation_config?: { chunk_length_schedule?: number[] }   // can override mid-stream
}

// 3) End-of-Stream sentinel — empty text:
type ElevenWsEOS = { text: "" }

// Server → client frames:
type ElevenWsServer =
  | { audio: string /* base64 */, isFinal: boolean | null, normalizedAlignment?: { chars: string[], charStartTimesMs: number[], charDurationsMs: number[] }, alignment?: { chars: string[], charStartTimesMs: number[], charDurationsMs: number[] } }
  | { error: string, message: string, code?: number }
```

There's also `multi-stream-input` (`/v1/text-to-speech/{voice_id}/multi-stream-input`) where each message carries a `context_id` so a single socket multiplexes parallel utterances — equivalent to Cartesia's context model. `[docs unclear]` on full message shape; same field set plus required `context_id`.

### Auth
`xi-api-key` header (sync + WS handshake); WS also accepts `xi_api_key` field in BOS frame.

### Fit notes
- `CommonSynthesizeRequest`: native — `model`(`model_id`), `text`, `voiceId`(URL path), `outputFormat`(query), `speed`(`voice_settings.speed`). Extras: `stability`, `similarity_boost`, `style`, `use_speaker_boost`, continuity context (`previous_text`/`next_text`/`previous_request_ids`).
- **Strongest fit for `openSynthesisSession`** — explicit incremental-text-in API with documented flush/EOS sentinels.

---

## Deepgram STT

Sources: [Listen streaming](https://developers.deepgram.com/reference/speech-to-text/listen-streaming), [Listen pre-recorded](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded), [Live streaming guide](https://developers.deepgram.com/docs/live-streaming-audio).

### Sync request shape — `POST https://api.deepgram.com/v1/listen`

Two content modes:

```ts
// Mode A: raw bytes upload
// Headers: Authorization: Token <KEY>, Content-Type: audio/* (e.g. audio/wav)
// Body: raw audio bytes.

// Mode B: URL fetch
// Headers: Authorization: Token <KEY>, Content-Type: application/json
type DeepgramUrlBody = { url: string }

// All options are query parameters:
type DeepgramListenQuery = {
  model?: "nova-3" | "nova-3-medical" | "nova-3-multilingual" | "nova-2" | "enhanced" | "base" | string
  version?: string
  language?: string                  // ISO; "multi" for nova-3 code-switching
  detect_language?: boolean
  punctuate?: boolean
  profanity_filter?: boolean
  redact?: Array<"pci"|"ssn"|"numbers"|"true"|string>
  diarize?: boolean
  smart_format?: boolean
  filler_words?: boolean
  paragraphs?: boolean
  summarize?: "v2" | boolean
  detect_topics?: boolean
  topics?: boolean
  sentiment?: boolean
  intents?: boolean
  utterances?: boolean
  utt_split?: number
  keyterm?: string[]                 // nova-3 only — up to 100; repeated query param
  keywords?: string[]                // legacy
  search?: string[]
  replace?: string[]
  callback?: string                  // async webhook
  tag?: string[]
  multichannel?: boolean
  alternatives?: number
  numerals?: boolean
  measurements?: boolean
  dictation?: boolean
  // raw-byte mode also needs:
  encoding?: "linear16"|"flac"|"mulaw"|"alaw"|"amr-nb"|"amr-wb"|"opus"|"ogg-opus"|"speex"|"g729"
  sample_rate?: number
  channels?: number
}

type DeepgramListenResponse = {
  metadata: { transaction_key: string, request_id: string, sha256: string, created: string, duration: number, channels: number, models: string[], model_info: Record<string, { name: string, version: string, arch: string }> }
  results: {
    channels: Array<{
      alternatives: Array<{
        transcript: string
        confidence: number
        words: Array<{ word: string, start: number, end: number, confidence: number, punctuated_word?: string, speaker?: number, speaker_confidence?: number, language?: string }>
        paragraphs?: { transcript: string, paragraphs: Array<{ sentences: Array<{ text: string, start: number, end: number }>, num_words: number, start: number, end: number, speaker?: number }> }
      }>
      detected_language?: string
      language_confidence?: number
    }>
    utterances?: Array<{ start: number, end: number, confidence: number, channel: number, transcript: string, words: unknown[], speaker?: number, id: string }>
    summary?: { result: "success"|string, short: string }
  }
}
```

### Streaming wire — `wss://api.deepgram.com/v1/listen`

Same query parameters as the sync endpoint, plus:

```ts
type DeepgramListenStreamingQuery = DeepgramListenQuery & {
  interim_results?: boolean
  endpointing?: number | false       // ms of silence; false disables
  vad_events?: boolean
  utterance_end_ms?: number          // ≥1000
  no_delay?: boolean
}
```

Client messages: raw audio frames as **binary** WebSocket frames (encoding/sample_rate already declared via query). Control messages as **text** JSON frames:

```ts
type DeepgramStreamClient =
  | { type: "KeepAlive" }
  | { type: "Finalize" }              // flush current utterance, get a final
  | { type: "CloseStream" }           // graceful close; server sends summary metadata then closes
```

Server messages — text JSON frames:

```ts
type DeepgramStreamServer =
  | { type: "Results"
    , channel_index: [number, number]
    , duration: number
    , start: number
    , is_final: boolean
    , speech_final: boolean
    , from_finalize?: boolean
    , channel: { alternatives: Array<{ transcript: string, confidence: number, words: Array<{ word: string, start: number, end: number, confidence: number, punctuated_word?: string, speaker?: number, language?: string }> }> }
    , metadata: { request_id: string, model_info: unknown, model_uuid: string }
    }
  | { type: "Metadata", request_id: string, transaction_key?: string, created?: string, duration?: number, channels?: number, model_info?: unknown }
  | { type: "SpeechStarted", channel: [number, number], timestamp: number }
  | { type: "UtteranceEnd", channel: [number, number], last_word_end: number }
  | { type: "Error", err_code?: string, err_msg?: string, request_id?: string, description?: string, variant?: string }
```

### Auth
`Authorization: Token ${DEEPGRAM_API_KEY}` for REST + WS handshake. Sec-WebSocket-Protocol-based auth is also documented `[docs unclear]` as a fallback.

### Fit notes
- `CommonTranscribeRequest`: native — `model`, `audio`(bytes or URL), `language`. `prompt` (vocab biasing) maps to `keyterm[]` — array vs single string is a divergence to surface in the common shape.
- Streaming **does not have a session-config message** — everything is query string. Cleanly fits `openSession({req}) → { audioIn, events }`.
- `is_final` vs `speech_final` is Deepgram-specific: `is_final` = "this transcript chunk is finalized within the utterance"; `speech_final` = "VAD-detected end of utterance". Common shape should collapse to `{ kind: "partial" | "final" | "utterance-end" }`.

---

## Deepgram TTS

Sources: [Speak REST request](https://developers.deepgram.com/reference/text-to-speech/speak-request), [Speak streaming WS](https://developers.deepgram.com/reference/transform-text-to-speech-websocket), [Streaming TTS guide](https://developers.deepgram.com/docs/streaming-text-to-speech).

### Sync request shape — `POST https://api.deepgram.com/v1/speak`

```ts
// Query params:
type DeepgramSpeakQuery = {
  model: "aura-2-thalia-en" | "aura-2-asteria-en" | "aura-1-asteria-en" | string  // <model>-<voice>-<lang>
  encoding?: "linear16" | "mulaw" | "alaw" | "mp3" | "opus" | "flac" | "aac"        // default linear16
  container?: "wav" | "ogg" | "none"                                                 // default wav (REST) / none (WS)
  sample_rate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000                // depends on encoding
  bit_rate?: number                                                                  // mp3/opus only
  callback?: string                                                                  // async
}

// Body — exactly one of:
type DeepgramSpeakBody = { text: string } | { url: string }

// Response: raw audio bytes (chunked). No JSON envelope.
```

### Streaming wire — `wss://api.deepgram.com/v1/speak`

Same query parameters as REST. Audio output flows as binary WebSocket frames; control flows as text JSON.

```ts
// Client → server (text JSON):
type DeepgramSpeakClient =
  | { type: "Speak", text: string }     // append text to buffer
  | { type: "Flush" }                   // generate audio for all buffered text now
  | { type: "Clear" }                   // discard buffered text + in-flight audio
  | { type: "Close" }                   // graceful close

// Server → client (text JSON for control; binary for audio):
type DeepgramSpeakServer =
  | { type: "Metadata", request_id: string, model_name: string, model_version: string, model_uuid: string }
  | { type: "Flushed", sequence_id: number }     // confirms a Flush
  | { type: "Cleared", sequence_id: number }     // confirms a Clear
  | { type: "Warning", description: string, code: string /* e.g. TEXT_LENGTH_WARNING */ }
  | { type: "Error", description: string, code?: string }
  // Audio chunks arrive as separate binary frames between control frames.
```

### Auth
`Authorization: Token ${DEEPGRAM_API_KEY}`.

### Fit notes
- `CommonSynthesizeRequest`: native — `model` (compound slug encodes both model and voiceId), `text`, `outputFormat` (split across `encoding`/`container`/`sample_rate`), no `speed`/`pitch`/`style`/`volume`.
- **Streaming text-in is supported**; `openSynthesisSession` maps neatly to `{ "Speak", text }` per message, with `Flush` to mark end of current utterance and queue closure to end session.
- Voice ID is wedged into `model`: no separate `voice` parameter. The common abstraction should still accept `voiceId` and assemble the slug.

---

## Cartesia STT

Sources: [Streaming STT reference](https://docs.cartesia.ai/api-reference/stt/stt), [Ink launch post](https://cartesia.ai/blog/introducing-ink-speech-to-text).

### Streaming wire — `wss://api.cartesia.ai/stt/websocket` `[docs unclear: exact path; SDKs use this base]`

Auth via headers at handshake or query: `Cartesia-Version: 2025-04-16` (date string) and `X-API-Key: …`, OR `?cartesia_version=…&api_key=…`.

Query params:

```ts
type CartesiaSttQuery = {
  model?: "ink-whisper" | string
  language?: string                   // "en" default
  encoding?: "pcm_s16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw" | string
  sample_rate?: number                // 16000 default
}
```

Messages:

```ts
// Client → server:
//   Binary frame: raw audio bytes per (encoding, sample_rate).
//   Text frame "done" — flushes remaining audio, server emits a final transcript + done, then closes.

// Server → client (JSON text frames):
type CartesiaSttServer =
  | { type: "transcript", request_id: string, text: string, is_final: boolean, duration?: number, language?: string, words?: Array<{ word: string, start: number, end: number }> }
  | { type: "flush_done", request_id: string }
  | { type: "done", request_id: string }
  | { type: "error", request_id?: string, message: string, code?: string }
```

### Sync
Cartesia documents only the streaming WS path for Ink-Whisper. `[docs unclear]` on a dedicated REST sync endpoint; the SDK appears to wrap the same WS for one-shot calls.

### Auth
`X-API-Key` + `Cartesia-Version` (both required; latter pins the API version).

### Fit notes
- `CommonTranscribeRequest`: native — `model`, `language`. `audio`(bytes-only) — no URL ingestion. `prompt`/vocab biasing **not exposed**.
- Streaming fits `Queue<AudioChunk>` + `Stream<TranscriptEvent>`; text `"done"` plays the role of Deepgram's `CloseStream`.

---

## Cartesia TTS

Sources: [TTS bytes (sync)](https://docs.cartesia.ai/api-reference/tts/bytes), [TTS WebSocket](https://docs.cartesia.ai/api-reference/tts/websocket), [Context flushing & flush IDs](https://docs.cartesia.ai/api-reference/tts/working-with-web-sockets/context-flushing-and-flush-i-ds).

### Sync request shape — `POST https://api.cartesia.ai/tts/bytes`

```ts
type CartesiaSpeechRequest = {
  model_id: "sonic-3" | "sonic-2" | "sonic-turbo" | string
  transcript: string
  voice:
    | { mode: "id", id: string /* UUID */, experimental_controls?: { speed?: "slowest"|"slow"|"normal"|"fast"|"fastest" | number, emotion?: string[] /* legacy */ } }
    | { mode: "embedding", embedding: number[], experimental_controls?: unknown }
  output_format: { container: "raw" | "wav" | "mp3", encoding: "pcm_f32le" | "pcm_s16le" | "pcm_mulaw" | "pcm_alaw" | "mp3", sample_rate: number }
  language?: string                   // "en" default
  speed?: number | "slowest"|"slow"|"normal"|"fast"|"fastest"   // sonic-2 path
  generation_config?: { volume?: number, speed?: number, emotion?: string }   // sonic-3 preferred
  duration?: number                   // seconds, max target
  add_timestamps?: boolean
}

// Response: raw audio bytes (Content-Type per output_format.container).
```

`/tts/sse` returns the same generation as SSE frames `{ type, data, done, step_time, context_id }`.

### Streaming wire — `wss://api.cartesia.ai/tts/websocket?api_key=…&cartesia_version=…`

```ts
// Client → server (text JSON frames). All carry context_id; multiplexing is built-in.
type CartesiaTtsClient = {
  context_id: string                  // free-form; same id = same generation/prosody
  model_id: string
  transcript: string
  voice: { mode: "id", id: string } | { mode: "embedding", embedding: number[] }
  output_format: { container: "raw" | "wav" | "mp3", encoding: string, sample_rate: number }
  language?: string
  continue?: boolean                  // true = expect more text on this context_id; false/omit = this is the last segment
  flush_id?: string                   // optional marker — server echoes a flush_done for it
  add_timestamps?: boolean
  generation_config?: unknown
}

// Server → client (text JSON):
type CartesiaTtsServer =
  | { type: "chunk", context_id: string, data: string /* base64 audio */, done: boolean, status_code: number, step_time?: number, flush_id?: string }
  | { type: "timestamps", context_id: string, word_timestamps: { words: string[], start: number[], end: number[] } }
  | { type: "flush_done", context_id: string, flush_id: string }
  | { type: "done", context_id: string }
  | { type: "error", context_id?: string, code?: number, message: string }
```

End-of-input mechanics: send a message with `continue: false` (or simply stop sending and the inactivity timeout fires). Closing the WebSocket without `continue:false` will leave the context unflushed.

### Auth
`X-API-Key` + `Cartesia-Version` headers (REST). For WS, query-param auth (`?api_key=…&cartesia_version=…`) is most common.

### Fit notes
- `CommonSynthesizeRequest`: native — `model`(`model_id`), `text`(`transcript`), `voiceId`(`voice.id`), `outputFormat` (split), `speed`. Extras: emotion arrays (legacy), voice embeddings, multi-context multiplexing.
- **Multiplexing via `context_id` is unique** — Cartesia and ElevenLabs' multi-stream-input are the only two that let one WS carry several parallel generations. Common `openSynthesisSession` returns one logical session; if exposing multiplexing, do so via a `context.fork()` provider extension.

---

## Azure Speech STT

Source: [REST API for short audio](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short).

### Sync request shape — `POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`

Audio bytes are the body. Limited to ≤60 s.

```ts
type AzureSttHeaders = {
  "Ocp-Apim-Subscription-Key"?: string
  Authorization?: `Bearer ${string}`        // either key or bearer token
  "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000" | "audio/ogg; codecs=opus"
  Accept?: "application/json"
  "Transfer-Encoding"?: "chunked"
  Expect?: "100-continue"
  "Pronunciation-Assessment"?: string       // base64-JSON
}
type AzureSttQuery = {
  language: string                          // BCP-47, REQUIRED
  format?: "simple" | "detailed"
  profanity?: "masked" | "removed" | "raw"
}

type AzureSttSimpleResponse = {
  RecognitionStatus: "Success" | "NoMatch" | "InitialSilenceTimeout" | "BabbleTimeout" | "Error"
  DisplayText: string
  Offset: string                            // 100-ns ticks
  Duration: string
  SNR?: number
}
type AzureSttDetailedResponse = AzureSttSimpleResponse & {
  NBest: Array<{
    Confidence: number
    Lexical: string
    ITN: string
    MaskedITN: string
    Display: string
    Words?: Array<{ Word: string, Offset: number, Duration: number, Confidence: number }>
  }>
}
```

Streaming STT is **SDK-only** (Speech SDK uses an internal WebSocket protocol that Microsoft does not document at the wire level; treat as opaque transport for our purposes).

### Auth
`Ocp-Apim-Subscription-Key` header (resource key) or `Authorization: Bearer <issueToken>` / Microsoft Entra `aad#<resourceId>#<token>` form.

### Fit notes
- Sync only at the wire level. To get true streaming STT you'd vendor the Speech SDK (out of scope for a thin abstraction). Flag as "partial coverage" in the matrix.

---

## Azure Speech TTS

Source: [REST text-to-speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech).

### Sync request shape — `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`

```ts
type AzureTtsHeaders = {
  Authorization?: `Bearer ${string}`
  "Ocp-Apim-Subscription-Key"?: string
  "Content-Type": "application/ssml+xml"
  "X-Microsoft-OutputFormat":
    | "audio-16khz-128kbitrate-mono-mp3" | "audio-24khz-96kbitrate-mono-mp3" | "audio-48khz-192kbitrate-mono-mp3"
    | "raw-16khz-16bit-mono-pcm" | "raw-24khz-16bit-mono-pcm" | "raw-48khz-16bit-mono-pcm"
    | "ogg-24khz-16bit-mono-opus" | "ogg-48khz-16bit-mono-opus"
    | "webm-24khz-16bit-mono-opus"
    | "raw-8khz-8bit-mono-mulaw" | "raw-8khz-8bit-mono-alaw"
    | "riff-24khz-16bit-mono-pcm" | string  // many more
  "User-Agent": string                      // required
}

// Body: SSML XML. Custom-voice deployments accept plain-text body.
const azureTtsBody = `
<speak version="1.0" xml:lang="en-US">
  <voice name="en-US-AvaMultilingualNeural">
    <mstts:express-as style="cheerful" styledegree="2">
      Hello, world.
    </mstts:express-as>
  </voice>
</speak>`

// Response: raw audio bytes (max 10 min synthesized).
```

Streaming = chunked transfer-encoding on this same endpoint; otherwise no separate streaming protocol at the wire level. Incremental-text-in WS is **SDK-internal** only.

### Auth
Same as STT.

### Fit notes
- `CommonSynthesizeRequest`: text must be wrapped as SSML at the adapter layer; `voiceId` becomes the `<voice name="…">` attribute. `speed`/`pitch`/`style` map via SSML prosody / `mstts:express-as`.
- No incremental-text-in WS at the wire level → `openSynthesisSession` = `Unsupported` unless we vendor the SDK.

---

## AWS Polly TTS

Source: [SynthesizeSpeech](https://docs.aws.amazon.com/polly/latest/dg/API_SynthesizeSpeech.html).

### Sync request shape — `POST https://polly.{region}.amazonaws.com/v1/speech`

```ts
type PollySynthesizeSpeechRequest = {
  Engine?: "standard" | "neural" | "long-form" | "generative"
  LanguageCode?: string                     // bilingual-voice override
  LexiconNames?: string[]                   // ≤5
  OutputFormat: "mp3" | "ogg_vorbis" | "ogg_opus" | "pcm" | "mulaw" | "alaw" | "json"  // json = speech marks only
  SampleRate?: "8000" | "16000" | "22050" | "24000" | "44100" | "48000"
  SpeechMarkTypes?: Array<"sentence" | "ssml" | "viseme" | "word">   // requires OutputFormat=json
  Text: string                              // ≤6000 chars, ≤3000 billed
  TextType?: "text" | "ssml"
  VoiceId: string                           // "Joanna" | "Matthew" | "Aria" | ... (large enum)
}

// Response:
//   HTTP/1.1 200
//   Content-Type: audio/mpeg | audio/ogg | audio/pcm | audio/mulaw | audio/alaw | application/x-json-stream
//   x-amzn-RequestCharacters: <int>
//   Body: raw audio stream (chunked).
```

Bidirectional streaming is a separate API as of March 2026 for Generative engine; not yet covered at the wire-doc level here `[docs unclear: separate operation name]`.

### Auth
AWS SigV4 — `Authorization: AWS4-HMAC-SHA256 Credential=…/{date}/{region}/polly/aws4_request, SignedHeaders=…, Signature=…` plus `x-amz-date`.

### Fit notes
- `CommonSynthesizeRequest`: native — `text`(`Text`), `voiceId`(`VoiceId`), `outputFormat`(`OutputFormat`+`SampleRate`). No `speed`/`pitch`/`volume` at the request level — must be expressed via SSML `<prosody>`. No streaming-text-in for non-Generative.
- SigV4 signing adds significant adapter complexity vs bearer-token providers.

---

## AWS Transcribe STT

Sources: [StartStreamTranscription API](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_streaming_StartStreamTranscription.html), [Streaming guide](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html), [WebSocket setup](https://docs.aws.amazon.com/transcribe/latest/dg/streaming-websocket.html).

### Sync
**No true sync REST endpoint.** `StartTranscriptionJob` is async/polling (out of scope per request). Streaming covers the low-latency path.

### Streaming wire — bidirectional HTTP/2 or WebSocket on `POST /stream-transcription`

Endpoint: `https://transcribestreaming.{region}.amazonaws.com:8443/stream-transcription` (HTTP/2) or `wss://transcribestreaming.{region}.amazonaws.com:8443/stream-transcription-websocket` (WebSocket; query params replace headers).

```ts
type StartStreamTranscriptionRequest = {
  // HTTP/2 path: headers (x-amzn-transcribe-*). WebSocket path: same names as URL query params.
  languageCode?:
    | "en-US"|"en-GB"|"es-US"|"fr-CA"|"fr-FR"|"en-AU"|"it-IT"|"de-DE"|"pt-BR"|"ja-JP"|"ko-KR"|"zh-CN"
    | string   // ~55 supported
  mediaEncoding: "pcm" | "ogg-opus" | "flac"
  mediaSampleRateHertz: number              // 8000..48000
  vocabularyName?: string
  sessionId?: string                        // UUIDv4
  vocabularyFilterName?: string
  vocabularyFilterMethod?: "remove" | "mask" | "tag"
  showSpeakerLabel?: boolean
  enableChannelIdentification?: boolean
  numberOfChannels?: number                 // 2 only
  enablePartialResultsStabilization?: boolean
  partialResultsStability?: "high" | "medium" | "low"
  contentIdentificationType?: "PII"
  contentRedactionType?: "PII"
  piiEntityTypes?: string                   // "EMAIL,PHONE,SSN,..." or "ALL"
  languageModelName?: string
  identifyLanguage?: boolean
  languageOptions?: string                  // comma-separated codes
  preferredLanguage?: string
  identifyMultipleLanguages?: boolean
  vocabularyNames?: string                  // comma-separated (auto-language path)
  vocabularyFilterNames?: string
}

// Event stream — client sends one of these per "event":
type TranscribeClientEvent =
  | { AudioEvent: { AudioChunk: Uint8Array } }
  | { ConfigurationEvent: { ChannelDefinitions?: Array<{ ChannelId: number, ParticipantRole: "AGENT" | "CUSTOMER" }>, PostCallAnalyticsSettings?: unknown } }
// Wire-encoded as AWS event-stream frames (HTTP/2 DATA frames or WS binary frames).

// Server → client events:
type TranscribeServerEvent = {
  TranscriptEvent: {
    Transcript: {
      Results: Array<{
        ResultId: string
        StartTime: number
        EndTime: number
        IsPartial: boolean
        Alternatives: Array<{
          Transcript: string
          Items: Array<{
            Type: "pronunciation" | "punctuation"
            Content: string
            StartTime: number
            EndTime: number
            Confidence?: number
            Speaker?: string
            Stable?: boolean
            VocabularyFilterMatch?: boolean
          }>
          Entities?: Array<{ Category: string, Type: string, Content: string, StartTime: number, EndTime: number, Confidence: number }>
        }>
        ChannelId?: string
        LanguageCode?: string
        LanguageIdentification?: Array<{ LanguageCode: string, Score: number }>
      }>
    }
  }
} | { BadRequestException: {} } | { ConflictException: {} } | { InternalFailureException: {} } | { LimitExceededException: {} } | { ServiceUnavailableException: {} }
```

Close mechanics: client closes the HTTP/2 stream (or the WebSocket). AWS event-stream framing carries an end-of-stream marker.

### Auth
AWS SigV4 (over HTTP/2 headers, or as query params on the WebSocket URL — `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-Signature`, `X-Amz-SignedHeaders`).

### Fit notes
- `CommonTranscribeRequest`: native — `model` (implicit per-language; no model knob), `audio` (streaming only — bytes only, no URL), `language`(`languageCode`). `prompt` maps to `vocabularyName`/`vocabularyNames` (must pre-register).
- **No sync endpoint** — `transcribe(req): Effect<TranscriptResult>` must be implemented by opening a session, draining the stream, then returning the concatenated final results — or throw `Unsupported`.
- AWS event-stream framing is a binary frame format on top of HTTP/2 / WS; needs a dedicated decoder. Significantly more transport machinery than every other provider.

---

## Inworld STT

Sources: [Intro to Realtime STT (docs.inworld.ai)](https://docs.inworld.ai/stt/overview), [Transcribe audio (WebSocket) reference](https://docs.inworld.ai/api-reference/sttAPI/speechtotext/transcribe-stream-websocket), [STT API with Voice Profiling](https://inworld.ai/resources/stt-voice-profiling-api), [API auth intro](https://docs.inworld.ai/api-reference/introduction).

Inworld's STT is a thin aggregator — the single endpoint routes to `inworld/inworld-stt-1`, `groq/whisper-large-v3`, AssemblyAI's universal-streaming, etc. via the `modelId` field. Voice profiling (emotion/age/accent/pitch/style) is an Inworld-specific overlay returned per chunk when the native `inworld/inworld-stt-1` model is selected.

### Sync request shape — `POST https://api.inworld.ai/stt/v1/transcribe`

`multipart/form-data` (file) or JSON body with audio content. `[docs unclear]` on whether URL ingestion is supported; only file upload is referenced in code examples.

```ts
type InworldTranscribeRequest = {
  modelId:
    | "inworld/inworld-stt-1"
    | "groq/whisper-large-v3"
    | "assemblyai/universal-streaming-multilingual"
    | string
  audioConfig?: {
    audioEncoding?: "LINEAR16" | "MULAW" | "ALAW" | "FLAC" | "MP3" | "OGG_OPUS" | "WAV"
    sampleRateHertz?: number              // optional for container formats — auto-detected from header
  }
  language?: string                       // BCP-47, e.g. "en-US"; omit for autodetect on supported models
  // file uploaded as form field `audio` (multipart); JSON path: { audioContent: base64 }   [docs unclear]
}

type InworldTranscribeResponse = {
  transcript: string
  language?: string
  words?: Array<{ word: string, start: number, end: number, confidence?: number, speakerId?: string }>
  voiceProfile?: InworldVoiceProfile      // only on inworld/inworld-stt-1
}
type InworldVoiceProfile = {
  emotion?:    Array<{ label: string, confidence: number }>
  accent?:     Array<{ label: string, confidence: number }>
  age?:        Array<{ label: string, confidence: number }>
  pitch?:      Array<{ label: string, confidence: number }>
  vocalStyle?: Array<{ label: string, confidence: number }>
}
```

### Streaming wire — `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional`

JSON frames in both directions. The first client frame MUST be a `transcribe_config`.

```ts
// Client → server:
type InworldSttClient =
  | { transcribe_config: {
        modelId: string                                   // see sync request
        audioEncoding: "LINEAR16" | "MULAW" | "ALAW" | "FLAC" | "OGG_OPUS"
        sampleRateHertz: number                           // 16000 recommended
        language?: string                                 // BCP-47
        interimResults?: boolean                          // [docs unclear: exact field name]
        enableVoiceProfile?: boolean                      // inworld/inworld-stt-1 only [docs unclear]
      } }
  | { audioChunk: { content: string /* base64 PCM, ~100ms chunks (3200B @ 16kHz s16le mono) */ } }
  | { endTurn: {} }                                       // optional — flush + final transcript for the current turn
  | { closeStream: {} }                                   // graceful close

// Server → client:
type InworldSttServer =
  | { result: {
        transcript: string
        isFinal: boolean
        language?: string
        words?: Array<{ word: string, start: number, end: number, confidence?: number, speakerId?: string }>
        voiceProfile?: InworldVoiceProfile                // attached per chunk when enabled
      } }
  | { speechActivity?: { type: "begin" | "end", at: number } }   // [docs unclear: presence / field names]
  | { error: { code?: string, message: string } }
```

Close mechanics: send `{ closeStream: {} }` then close the WebSocket; server flushes a final `result` with `isFinal:true` before TCP close.

### Auth
`Authorization: Basic ${BASE64_API_KEY}` (REST + WS handshake). JWT also supported for client-side use. API keys are scoped to a workspace — keys generated in workspace-A reject workspace-B requests.

### Fit notes
- `CommonTranscribeRequest`: native — `model`(`modelId`), `audio`(file or audioContent), `language`. `prompt` (vocab biasing) — `[docs unclear]`; not documented at the wire level. `diarization` and `wordTimestamps` — `[docs unclear]`; presumed gated by the underlying model (Whisper-large-v3 supports word timestamps).
- `streamTranscriptionFrom` cleanly fits the `Stream<Uint8Array>` → `Stream<TranscriptEvent>` shape. Config message is a true session-config frame (unlike Deepgram which is query-string-only).
- Voice profiling is an Inworld extension — surface as `metadata.raw` in the common event, or expose a provider-specific extension event.
- Aggregator nature: behavior of `language`, `wordTimestamps`, and `diarization` depends on the chosen `modelId`. The adapter cannot promise these uniformly without inspecting the model.

---

## Inworld TTS

Sources: [Intro to Realtime TTS (docs.inworld.ai)](https://docs.inworld.ai/tts/tts), [TTS API quickstart](https://inworld.ai/resources/tts-api-quickstart), [Realtime API: Expressive Speech-to-Speech](https://inworld.ai/realtime-api), [Realtime API (WebSocket) reference](https://docs.inworld.ai/api-reference/realtimeAPI/realtime/realtime-websocket), [Drop-in OpenAI TTS replacement](https://inworld.ai/resources/tts-openai-sdk-drop-in-replacement), [TTS-2 launch](https://inworld.ai/blog/realtime-tts-2), [Generating audio (formats)](https://docs.inworld.ai/tts/capabilities/generating-audio).

Models: `inworld-tts-2` (current frontier), `inworld-tts-1.5`, `inworld-tts-1.5-max`, `inworld-tts-1`, `inworld-tts-1-max`. Voice IDs are name strings (`"Ashley"`, `"Alex"`, `"Sarah"`, …) for system voices; cloned voices receive an opaque ID from the voice-clone endpoint.

### Sync request shape — `POST https://api.inworld.ai/tts/v1/voice`

`application/json`. Response body is JSON with **base64-encoded** audio (not raw bytes).

```ts
type InworldSpeechRequest = {
  text: string
  voiceId: string                          // system name or cloned voice id; field name is camelCase
  modelId: "inworld-tts-2" | "inworld-tts-1.5" | "inworld-tts-1.5-max" | "inworld-tts-1" | "inworld-tts-1-max" | string
  audioConfig?: {
    audioEncoding?: "MP3" | "LINEAR16" | "WAV" | "OGG_OPUS" | "MULAW" | "ALAW" | "FLAC"   // default MP3
    sampleRateHertz?: number               // 8000..48000; default 24000
    bitrateBps?: number                    // mp3/opus only [docs unclear: exact field name]
  }
  temperature?: number                     // [docs unclear: range]
  // [docs unclear] — pronunciation dictionary / pronunciations[] supported on some models per the blog
}

type InworldSpeechResponse = {
  audioContent: string                     // base64 of audio (with container if MP3/OGG/WAV)
}
```

### Streaming wire (HTTP NDJSON) — `POST https://api.inworld.ai/tts/v1/voice:stream`

Identical request body. Response is **newline-delimited JSON**; each line is an envelope with a base64 audio chunk.

```ts
type InworldSpeechNdjsonChunk = {
  result?: { audioContent: string /* base64 audio chunk */ }
  // Final chunk may include timestamps / usage [docs unclear].
}
// Stream terminates with normal HTTP EOF.
```

### Streaming wire (WebSocket, incremental text in) — `wss://api.inworld.ai/api/v1/realtime/session`

Query: `?key=<session-id>&protocol=realtime` (Basic auth at handshake). The protocol mirrors OpenAI's Realtime event shape with Inworld extensions for selecting STT/TTS/LLM components — TTS-only usage just configures the `audio.output` block.

```ts
// Client → server:
type InworldRealtimeClient =
  | { type: "session.update", session: {
        type: "realtime"
        modelId?: string                                  // LLM if doing full S2S; omit for TTS-only
        instructions?: string
        output_modalities?: Array<"audio" | "text">
        audio?: {
          output?: {
            model: "inworld-tts-2" | "inworld-tts-1.5" | string
            voice: string                                  // voice name
            audioConfig?: { audioEncoding?: "PCM" | "MP3" | "OGG_OPUS" | string, sampleRateHertz?: number }
          }
        }
      } }
  | { type: "conversation.item.create", item: {
        type: "message"
        role: "user" | "assistant"
        content: Array<{ type: "input_text" | "text", text: string }>
      } }                                                  // append a text item to be synthesized
  | { type: "response.create", response?: { modalities?: Array<"audio" | "text"> } }   // request synthesis now

// Server → client (TTS-relevant):
type InworldRealtimeServer =
  | { type: "session.created" | "session.updated", session: unknown }
  | { type: "response.audio.delta", response_id: string, item_id: string, delta: string /* base64 audio */ }
  | { type: "response.audio.done",  response_id: string, item_id: string }
  | { type: "response.audio_transcript.delta", delta: string }    // model's spoken text mirrored back
  | { type: "response.done", response: { id: string, status: "completed" | "incomplete" | "failed", usage?: unknown } }
  | { type: "error", error: { type: string, code?: string, message: string } }
```

Server emits a periodic ping every 60 s. Close mechanics: standard WS close from client; no application-level "end" message is required for TTS.

### OpenAI-compatible endpoint
`[docs unclear]` — Inworld markets a "drop-in OpenAI TTS replacement," but inspection shows it routes through the native `/tts/v1/voice` endpoint with `voiceId`/`modelId` field renaming and base64-decoded `audioContent`. **There is no `/v1/audio/speech` URL on api.inworld.ai that mirrors OpenAI's wire shape verbatim** per the cited resource page; "drop-in" is delivered at the SDK level, not the HTTP level.

### Auth
`Authorization: Basic ${BASE64_API_KEY}` (REST + WS handshake), workspace-scoped. JWT alternative for browser use.

### Fit notes
- `CommonSynthesizeRequest`: native — `model`(`modelId`), `text`, `voiceId`, `outputFormat` (split across `audioEncoding`/`sampleRateHertz`/`bitrateBps`). `speed` — `[docs unclear]`; not visibly documented at the request level (the realtime API instead steers prosody via free-text `instructions`, OpenAI-style). `languageCode` — not at top level; Inworld TTS-2 advertises 100+ languages auto-handled and mid-utterance switching from the voice profile itself.
- Response shape divergence — sync endpoint returns **JSON with base64 audio**, not raw audio bytes. Adapter must base64-decode before exposing `AudioBlob`.
- `streamSynthesisFrom` (incremental text in WS): achievable via the realtime session, but the wire shape is the **OpenAI Realtime event protocol**, not a simple "send text frame → receive audio frame." Each text segment is wrapped as a `conversation.item.create` followed by `response.create`. Higher impedance mismatch than ElevenLabs/Deepgram/Cartesia stream-input.
- Streaming HTTP path uses NDJSON (not SSE) — uncommon framing; adapter needs a line-splitter, not an SSE parser.
- Aggregator characteristic does **not** extend to TTS — TTS models are all Inworld-native, unlike STT.

---

## MiniMax TTS

Sources: [T2A HTTP reference (platform.minimax.io)](https://platform.minimax.io/docs/api-reference/speech-t2a-http), [T2A WebSocket reference](https://platform.minimax.io/docs/api-reference/speech-t2a-websocket), [T2A WebSocket guide](https://platform.minimax.io/docs/guides/speech-t2a-websocket), [Voice clone guide](https://platform.minimax.io/docs/guides/speech-voice-clone), [Speech-02 launch](https://www.minimax.io/news/speech-02-series), [API overview](https://platform.minimax.io/docs/api-reference/api-overview), Chinese mainland doc center [platform.minimaxi.com](https://platform.minimaxi.com/docs/guides/speech-t2a-websocket).

Note on **STT**: MiniMax does not publish a first-class real-time STT endpoint at writing. Third-party references describe an async submit-and-poll `POST /v1/stt/create` → `GET /v1/stt/{generation_id}` returning a `generation_id` job (analogous to AWS `StartTranscriptionJob`), advertised as a Speech-2.5 capability. The endpoint is not in the platform.minimax.io API reference at the time of compilation and field shapes are **not citably documented** — treat as `[docs unclear]` and gate behind a feature flag, or expose `transcribe()` / `streamTranscriptionFrom()` as `Unsupported` until MiniMax publishes a stable spec. No public WebSocket streaming STT exists.

Models (TTS): `speech-2.8-hd`, `speech-2.8-turbo`, `speech-2.6-hd`, `speech-2.6-turbo` (latest real-time pair), `speech-02-hd`, `speech-02-turbo`, `speech-01-hd`, `speech-01-turbo`. Voice IDs are slug strings — system voices like `"male-qn-qingse"`, `"Chinese (Mandarin)_Warm_Bestie"`, `"English_expressive_narrator"`, etc.; cloned voices use the user-assigned `voice_id` registered via the voice-clone endpoint.

### Sync request shape — `POST https://api.minimax.io/v1/t2a_v2`

International host: `api.minimax.io`. **Mainland China host: `api.minimaxi.com`** (extra `i`); per docs your API key region must match the host region. Both expose the same path; the platform doc center for the mainland endpoint is at `platform.minimaxi.com`. Query string: `?GroupId=<group-id>` (required, identifies the org).

```ts
type MiniMaxT2AV2Request = {
  model: "speech-2.8-hd" | "speech-2.8-turbo" | "speech-2.6-hd" | "speech-2.6-turbo"
       | "speech-02-hd" | "speech-02-turbo" | "speech-01-hd" | "speech-01-turbo" | string
  text: string                              // up to ~10 000 chars; >3 000 recommended to stream
  stream?: boolean                          // default false; true switches the response to SSE
  language_boost?:                          // bias to a target language during synthesis
    | "Chinese" | "English" | "Spanish" | "French" | "Russian" | "German"
    | "Portuguese" | "Italian" | "Japanese" | "Korean" | "Indonesian"
    | "Vietnamese" | "Turkish" | "Dutch" | "Ukrainian" | "auto" | string
  voice_setting: {
    voice_id: string                        // system slug OR cloned voice_id (user-assigned, unique per account)
    speed?: number                          // 0.5..2.0, default 1.0
    vol?: number                            // 0..10, default 1.0
    pitch?: number                          // -12..12, default 0
    emotion?: "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised" | "neutral"
    english_normalization?: boolean
  }
  audio_setting: {
    sample_rate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100   // default 32000
    bitrate?: 32000 | 64000 | 128000 | 256000                   // mp3 only; default 128000
    format?: "mp3" | "pcm" | "flac" | "wav"                     // default mp3
    channel?: 1 | 2                                             // default 1
  }
  pronunciation_dict?: {
    tone?: string[]                         // e.g. ["处理/(chu3)(li3)", "Omg/Oh my god"]
  }
  voice_modify?: {                          // optional voice perturbation
    pitch?: number; intensity?: number; timbre?: number
    sound_effects?: "spacious_echo" | "auditorium_echo" | "lofi_telephone" | "robotic" | string
  }
  timber_weights?: Array<{ voice_id: string, weight: number }>   // voice mixing
  subtitle_enable?: boolean                 // speech-01-turbo / speech-01-hd only
  stream_options?: { exclude_aggregated_audio?: boolean }        // SSE only — drop the duplicate final-chunk audio
  output_format?: "url" | "hex"             // default "hex"; "url" only on non-stream and returns CDN URL
}

type MiniMaxT2AV2Response = {
  data: {
    audio: string                           // hex-encoded audio bytes (or CDN URL if output_format="url")
    status: 1 | 2                           // 1 = partial chunk (SSE), 2 = final aggregated
    ced?: string                            // [docs unclear]
  }
  extra_info: {
    audio_length: number                    // ms
    audio_sample_rate: number
    audio_size: number                      // bytes (pre-hex)
    bitrate: number
    word_count: number
    invisible_character_ratio: number
    audio_format: "mp3" | "pcm" | "flac" | "wav"
    usage_characters: number
  }
  subtitle_file?: string                    // URL when subtitle_enable=true
  trace_id: string
  base_resp: { status_code: 0 | number, status_msg: "success" | string }
}
```

### Streaming wire (HTTP SSE) — `POST https://api.minimax.io/v1/t2a_v2?GroupId=…` with `stream:true`

Response is `text/event-stream`. Each `data: <json>\n\n` event carries the same `MiniMaxT2AV2Response` envelope; partial chunks have `data.status === 1`, the final aggregated chunk has `data.status === 2`. Setting `stream_options.exclude_aggregated_audio:true` makes the terminal chunk metadata-only (no duplicate audio).

```ts
type MiniMaxSseEvent = MiniMaxT2AV2Response  // one envelope per `data:` line
```

### Streaming wire (WebSocket, incremental text in) — `wss://api.minimax.io/ws/v1/t2a_v2`

Mainland mirror: `wss://api.minimaxi.com/ws/v1/t2a_v2`. The session lifecycle is event-driven JSON frames.

```ts
// Client → server (text JSON frames):
type MiniMaxTtsClient =
  | { event: "task_start"
    , model: string
    , language_boost?: string
    , voice_setting: { voice_id: string, speed?: number, vol?: number, pitch?: number, emotion?: string }
    , pronunciation_dict?: { tone?: string[] }
    , audio_setting: { sample_rate?: number, bitrate?: number, format?: "mp3" | "pcm" | "flac" | "wav", channel?: 1 | 2 }
    }
  | { event: "task_continue", text: string }   // append text to synthesize; multiple allowed
  | { event: "task_finish" }                   // graceful end — server flushes remaining audio

// Server → client (text JSON):
type MiniMaxTtsServer =
  | { event: "connected_success", session_id: string, trace_id: string }
  | { event: "task_started", session_id: string, trace_id: string }
  | { event: "task_continued"
    , session_id: string
    , data: { audio: string /* hex */, status: 1 | 2 }
    , extra_info?: MiniMaxT2AV2Response["extra_info"]
    , is_final?: boolean
    , trace_id: string
    }
  | { event: "task_finished", session_id: string, trace_id: string }
  | { event: "task_failed",   session_id: string, trace_id: string, base_resp: { status_code: number, status_msg: string } }
```

Close mechanics: send `{ event: "task_finish" }` and wait for `task_finished` before closing the WS. Closing without `task_finish` discards buffered text.

Idle-billing footgun: leaving a WS open without `task_finish` keeps the session active and continues to count toward concurrent-connection limits; some tiers also bill connect time `[docs unclear]`.

### Auth
`Authorization: Bearer ${MINIMAX_API_KEY}` (REST + WS handshake) plus the **`GroupId` query parameter** that identifies the org (not the API key — both are required). Region must match: `api.minimax.io` ↔ international key, `api.minimaxi.com` ↔ mainland-China key. WS auth uses the same `Authorization` header at handshake.

### Fit notes
- `CommonSynthesizeRequest`: native — `model`, `text`, `voiceId`(`voice_setting.voice_id`), `outputFormat`(split across `audio_setting.format` / `sample_rate` / `bitrate` / `channel`), `speed`(`voice_setting.speed`), `languageCode`(maps to `language_boost`, which is a name string not a BCP-47 code — adapter must translate `"en-US"` → `"English"`).
- Extras beyond the common shape: `vol`, `pitch`, `emotion`, `pronunciation_dict.tone`, `voice_modify`, `timber_weights` (voice mixing), `subtitle_file`. Expose as a provider-specific extension.
- `streamSynthesisFrom` (incremental text in WS): **fully achievable** via `task_start` → `task_continue*` → `task_finish` — clean fit, comparable to Deepgram's `Speak` / `Close`. No multiplexing (no `context_id`).
- Audio is **hex-encoded JSON-string** chunks in every flavor (sync, SSE, WS) — not raw binary frames. Adapter must hex-decode before exposing `AudioChunk`. This is unusual; every other provider in the doc emits raw bytes (or base64 inside a JSON envelope).
- `streamTranscriptionFrom` and `transcribe`: **`Unsupported`** at the public-API level for now (see the STT note above).
- Geographic / data-sovereignty: choosing the wrong host returns `invalid_api_key`; document `MINIMAX_REGION = "global" | "mainland"` as a required adapter configuration value rather than auto-detecting.
- `GroupId` mandatory query param is unique among providers in this doc — none of the others demand a side-channel org identifier on every request.

---

## Cross-provider summary — common-shape coverage

### `CommonTranscribeRequest` fit (✓ native / E = needs provider extension / × = not supported)

| Field          | OpenAI | Google     | ElevenLabs | Deepgram | Cartesia | Azure | AWS Transcribe | Inworld | MiniMax |
|----------------|--------|------------|------------|----------|----------|-------|----------------|---------|---------|
| `model`        | ✓      | ✓          | ✓          | ✓        | ✓        | × (engine implicit) | × (no model knob) | ✓ (`modelId`; aggregator) | × (no public STT) |
| `audio.file`   | ✓      | ✓ (base64) | ✓          | ✓        | ✓        | ✓     | × (stream-only) | ✓       | × |
| `audio.url`    | × (must upload) | ✓ (gs:// only) | ✓ (`cloud_storage_url`) | ✓ | × | × | × | `[docs unclear]` | × |
| `language`     | ✓      | ✓ (array)  | ✓          | ✓        | ✓        | ✓ (required) | ✓ | ✓ | × |
| `prompt` (vocab biasing) | ✓ | ✓ (adaptation phrases) | × on sync | E (`keyterm[]`) | × | × | E (`vocabularyName`) | `[docs unclear]` | × |
| `diarization`  | × (sep model) | E | E (`diarize`) | E (`diarize`) | × | × | E (`showSpeakerLabel`) | E (model-gated) | × |
| `wordTimestamps` | E (whisper+verbose only) | E (`enableWordTimeOffsets`) | E (`timestamps_granularity`) | always (streaming) | E | E (detailed) | always | E (model-gated) | × |

### `CommonSynthesizeRequest` fit

| Field         | OpenAI | Google     | ElevenLabs | Deepgram | Cartesia | Azure       | AWS Polly | Inworld | MiniMax |
|---------------|--------|------------|------------|----------|----------|-------------|-----------|---------|---------|
| `model`       | ✓      | E (via voice name) | ✓ | E (compound slug) | ✓ | E (via SSML/voice) | E (`Engine`) | ✓ (`modelId`) | ✓ |
| `text`        | ✓ (`input`) | ✓ | ✓ | ✓ | ✓ (`transcript`) | E (must be SSML) | ✓ | ✓ | ✓ |
| `voiceId`     | ✓ (slug, fixed) | ✓ (slug) | ✓ (URL) | E (compound slug) | ✓ (UUID) | ✓ (SSML attr) | ✓ | ✓ (name string) | ✓ (slug) |
| `outputFormat`| ✓ | ✓ | ✓ | E (split fields) | E (split fields) | E (single combined slug) | E (`OutputFormat`+`SampleRate`) | E (split: `audioEncoding`/`sampleRateHertz`/`bitrateBps`) | E (split: `format`/`sample_rate`/`bitrate`/`channel`) |
| `speed`       | ✓ | ✓ (`speakingRate`) | ✓ (`voice_settings.speed`) | × | ✓ | E (SSML prosody) | × (SSML only) | `[docs unclear]` | ✓ (`voice_setting.speed`) |
| `pitch`       | × | ✓ | × | × | × | E (SSML) | × (SSML only) | × | E (`voice_setting.pitch`) |
| `volume`      | × | ✓ (`volumeGainDb`) | × | × | E | E (SSML) | × | × | E (`voice_setting.vol`) |
| `style`/emotion | E (`instructions` prose) | × | E (`style`,`stability`) | × | E (emotion[]) | E (`mstts:express-as`) | × | E (Realtime API `instructions`) | E (`emotion` enum) |
| `languageCode` | × (voice-implicit) | ✓ | ✓ | × | ✓ | ✓ (SSML `xml:lang`) | E (`LanguageCode`) | × (voice-implicit, multi-lang) | E (`language_boost` name-string) |

### Session shape compatibility

| Provider     | `streamTranscriptionFrom` (STT) | `streamSynthesisFrom` (TTS, incremental text in) |
|--------------|----------------------------------|---------------------------------------------------|
| OpenAI       | ✓ Realtime WS                    | × — only chunked-HTTP audio out, full-text in     |
| Google       | ✓ gRPC bidi                      | ✓ Chirp 3 HD voices only (gRPC bidi)              |
| ElevenLabs   | ✓ WS                             | ✓ stream-input WS (canonical implementation)      |
| Deepgram     | ✓ WS                             | ✓ Speak/Flush/Clear/Close WS                      |
| Cartesia     | ✓ WS                             | ✓ WS with context_id multiplexing                 |
| Azure        | × (SDK only at wire level)       | × (SDK only)                                      |
| AWS Polly    | n/a (no STT here)                | × (chunked HTTP out; Generative bidirectional streaming is new and not yet at wire-doc level here) |
| AWS Transcribe | ✓ HTTP/2 or WS event-stream    | n/a                                               |
| Inworld      | ✓ WS (`transcribe:streamBidirectional`) | ✓ via Realtime API (OpenAI-Realtime event protocol; higher impedance than ElevenLabs-style stream-input) |
| MiniMax      | × (no public real-time STT at writing — `/v1/stt/create` is async submit-and-poll, `[docs unclear]`) | ✓ WS `task_start`/`task_continue`/`task_finish` (no multiplexing) |

### STT event-shape divergence

| Provider     | Partial/Interim shape | Final shape                                       | VAD event surface                     |
|--------------|-----------------------|---------------------------------------------------|---------------------------------------|
| OpenAI       | `.delta { delta: string }` (text only) | `.completed { transcript }` | `speech_started`/`speech_stopped`     |
| Google       | `is_final:false` + `stability` score | `is_final:true` + words[]   | `speech_event_type` enum              |
| ElevenLabs   | `partial_transcript { text }` | `committed_transcript` / `committed_transcript_with_timestamps` | implicit via commit |
| Deepgram     | `Results { is_final:false }` (with words) | `Results { is_final:true }` | `SpeechStarted`/`UtteranceEnd`       |
| Cartesia     | `transcript { is_final:false }` | `transcript { is_final:true }`            | `[docs unclear]`                      |
| AWS Transcribe | `Results { IsPartial:true }` (with Items, optional Stable) | `Results { IsPartial:false }` | none separate (encoded via Items)    |

Common shape recommendation:

```ts
type TranscriptEvent =
  | { _: "partial",  text: string, words?: WordTimestamp[], stability?: number }
  | { _: "final",    text: string, words?: WordTimestamp[] }
  | { _: "speech-started", at: number /* seconds */ }
  | { _: "utterance-ended", at: number }
  | { _: "audio-event", label: string, start: number, end: number }   // ElevenLabs only
  | { _: "metadata", raw: unknown }
  | { _: "error", code?: string, message: string }
```

### Implications for the abstraction (additions beyond `stt-tts.md`)

1. **No-streaming-text-in providers must explicitly throw `Unsupported`** on `openSynthesisSession`: OpenAI, Azure (at wire level), AWS Polly (non-Generative). Cartesia's `context_id` and ElevenLabs `multi-stream-input` give us free multiplexing on those two; consider whether the common shape exposes it.
2. **No-sync-STT providers**: AWS Transcribe. Either synthesize a sync wrapper around the streaming session, or expose `transcribe()` as `Unsupported`.
3. **No-URL-audio providers** for sync STT: OpenAI, Cartesia, Azure short-audio, AWS Transcribe. `AudioInput` should be a tagged union and the adapter routes accordingly (`File` always supported; `Url` is best-effort).
4. **Format slug divergence**: ElevenLabs encodes container+rate+bitrate into one query string (`mp3_44100_128`); Cartesia/Deepgram split across three fields; Azure uses one combined slug per format/sample-rate combo; Polly takes `OutputFormat`+`SampleRate`. The common `AudioFormat` shape needs `{ container, encoding, sampleRate, bitRate? }` and per-provider format-table validation.
5. **Auth divergence**: bearer (OpenAI), `xi-api-key` header (ElevenLabs), `Authorization: Token` (Deepgram), `X-API-Key`+`Cartesia-Version` (Cartesia), `Ocp-Apim-Subscription-Key` or Entra (Azure), AWS SigV4 (AWS), Google OAuth2/ADC. The adapter layer is the only place that knows; the user supplies provider-specific credential payloads.
6. **Vocab biasing** is the most under-modeled common field. Single-string `prompt` (OpenAI, whisper) loses information that map best as an array (Deepgram `keyterm`, Google adaptation phrases, AWS `vocabularyName`). Recommend the common shape take `prompt: string | { terms: string[] }`.
