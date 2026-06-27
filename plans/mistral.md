# Plan: Mistral provider (LLM + Voxtral STT/TTS)

Status: proposed. Goal: add Mistral as a first-class provider covering chat
completions (LanguageModel), realtime + batch transcription (Transcriber), and
streaming text-to-speech (SpeechSynthesizer), then make the `voice-loop` recipe
runnable as an end-to-end Mistral pipeline (Voxtral STT, Mistral LLM, Voxtral TTS).

## 1. API research summary

All Mistral surfaces sit under `https://api.mistral.ai`, auth via
`Authorization: Bearer $MISTRAL_API_KEY`. Sources are listed at the bottom.

### 1a. Chat completions (LLM)

- `POST https://api.mistral.ai/v1/chat/completions`, SSE streaming with `stream: true`.
- OpenAI-chat-shaped: `messages[]` with roles `system|user|assistant|tool`,
  streaming deltas at `choices[0].delta.content`.
- Tools: `tools: [{ type: "function", function: { name, description, parameters } }]`
  where `parameters` is a JSON Schema object. Streamed tool calls arrive at
  `choices[0].delta.tool_calls[]` with `{ id, type: "function", function: { name, arguments } }`
  (arguments stream as a JSON string).
- `tool_choice`: `"auto" | "any" | "none"` (note: Mistral uses **`"any"`** for
  forced use, not OpenAI's `"required"`). Also `parallel_tool_calls: boolean`.
- Tool result message: `{ role: "tool", name, tool_call_id, content }`.
- Structured output: `response_format: { type: "json_object" }` or
  `{ type: "json_schema", json_schema: { name, schema, strict } }`.
- Models (verify exact ids at build time): `mistral-large-latest`,
  `mistral-medium-latest` (Medium 3.5), `mistral-small-latest` (Small 4),
  `magistral-medium-latest` (reasoning). Usage returned as `usage: { prompt_tokens, completion_tokens, total_tokens }`.

### 1b. Voxtral realtime STT (streaming)

- WebSocket: `wss://api.mistral.ai/...` (exact path to confirm against the SDK;
  auth via `Authorization: Bearer` header on the upgrade request).
- Model: `voxtral-mini-transcribe-realtime-2602`. Latency configurable via
  `target_streaming_delay_ms` (e.g. 240 fast .. 2400 slow), sub-200ms achievable.
- Audio in: raw PCM `pcm_s16le`, 16000 Hz, mono, sent as binary frames as it arrives.
- Server events (class names from SDK, JSON `type` discriminator to confirm):
  - `RealtimeTranscriptionSessionCreated` (session ack)
  - `TranscriptionStreamTextDelta` -> `.text` (incremental transcript)
  - `TranscriptionStreamDone` (utterance/stream end)
  - `RealtimeTranscriptionError` -> `.error`
  - plus an unknown/catch-all event.
- Not compatible with `diarize` in realtime mode.

### 1c. Voxtral batch STT (offline)

- `POST https://api.mistral.ai/v1/audio/transcriptions`, multipart form.
- Fields: `file` (or `file_url` / `file_id`), `model`, `language?`,
  `diarize?` (bool, default false), `temperature?`,
  `timestamp_granularities?: ["segment" | "word"]`, `context_bias?: string[]`.
- Model: `voxtral-mini-latest` (a.k.a. Voxtral Mini Transcribe V2), 13 languages,
  word timestamps + diarization + context biasing.
- Response: `{ model, text, language, segments[], usage: { prompt_audio_seconds, prompt_tokens, completion_tokens, total_tokens } }`.
- Streaming variant: same path with `stream=true`, returns SSE.

### 1d. Voxtral TTS

- Model: `voxtral-mini-tts-2603`. Zero-shot voice cloning from 2-3s of audio.
- Request fields: `model`, `input` (text), voice via `voice_id` (saved voice) or
  `ref_audio` (one-off reference clip for cloning), `response_format`.
- Output formats: `mp3 | wav | pcm | flac | opus`. **`pcm` is float32 LE**
  (`pcm_f32le`), recommended for streaming (time-to-first-audio ~0.8s vs ~3s mp3).
- Response: base64 in `audio_data` for the basic call; a streaming variant exists
  (transport to confirm: SSE chunks of base64 audio vs chunked binary).
- Pricing reference: $0.016 / 1k chars.

## 2. Package layout

Mirror the existing split where OpenAI's _chat_ lives in `@effect-uai/responses`
and OpenAI's _audio_ lives in `@effect-uai/openai`. For Mistral:

- `@effect-uai/mistral` -> LanguageModel only (chat completions protocol).
- `@effect-uai/voxtral` -> Transcriber (realtime + batch) + SpeechSynthesizer (TTS).
  Voxtral is Mistral's own brand name for the audio family, so the package name
  reads naturally and keeps one-API-surface-per-package (see `project_package_scope`).

Alternative considered: a single `@effect-uai/mistral` holding everything. Rejected
to keep packages scoped to one protocol surface and to let audio-only users avoid
the LLM codec (and vice versa). Both debut at the current fixed-group version
(0.8.0), per `project_fixed_group_initial_version`.

```
packages/providers/mistral/
  src/
    Mistral.ts        # LanguageModel service + layer (chat completions)
    codec.ts          # CommonRequest <-> Mistral wire; SSE chunk -> TurnEvent
    models.ts         # MistralModel union
    index.ts
  package.json  tsconfig.json  tsdown.config.ts  README.md

packages/providers/voxtral/
  src/
    VoxtralTranscriber.ts        # batch STT (POST /audio/transcriptions)
    VoxtralRealtimeTranscriber.ts# realtime STT (WebSocket)
    realtimeStt.ts               # WS wiring (Socket + Queue<_, Cause.Done>)
    VoxtralSynthesizer.ts        # TTS (synthesize + streaming)
    models.ts
    index.ts
  package.json  tsconfig.json  tsdown.config.ts  README.md
```

Each `package.json` copies an existing provider's shape: `effect@4.0.0-beta.57`
and `@effect-uai/core` as peer deps, per-module `exports`, `tsdown` build,
`tsc --noEmit` typecheck. `voxtral` adds `ws` (+ `@types/ws`) as an optional peer,
exactly like `@effect-uai/openai`, for the realtime socket. Register both packages
in `pnpm-workspace.yaml` (already covered by `packages/providers/*`).

## 3. Implementation

### 3a. `@effect-uai/mistral` (LanguageModel)

Follow the Anthropic/Responses pattern:

- `MistralRequest = Omit<CommonRequest, "model"> & { model: MistralModel; safePrompt?: boolean; randomSeed?: number }`.
- `make(cfg): Effect<MistralService, never, HttpClient>` and
  `layer(cfg): Layer<Mistral | LanguageModel, never, HttpClient>` registering both
  the typed `Mistral` tag and the generic `LanguageModel` tag.
- `Config = { apiKey: Redacted; baseUrl?: string }`.
- `codec.ts`:
  - Encode: `history` -> Mistral `messages[]` (map our Items message/tool-call/
    tool-output/reasoning); `descriptorsOf(request.tools)` -> `tools[]`
    (`{ type: "function", function: { name, description, parameters: inputSchema } }`);
    map `toolChoice` (`required` -> `"any"`); map `structured` -> `response_format`
    `json_schema`.
  - Decode SSE: accumulate `choices[0].delta.content` -> `TextDelta`;
    `delta.tool_calls` -> `ToolCallStart` / `ToolCallArgsDelta`; final chunk +
    `usage` -> `UsageUpdate` + `TurnComplete` with `stopReason` mapped from
    `finish_reason` (`stop|length|tool_calls|...`).
  - `turn` derived via the shared `turnFromStream(streamTurn)` helper.
- Error mapping: 401 -> AuthFailed, 429 -> RateLimited, 5xx -> Unavailable,
  422/400 -> InvalidRequest, with `provider: "mistral"`.

### 3b. `@effect-uai/voxtral` Transcriber (batch)

- Implement `TranscriberService.transcribe`: build multipart
  (`file`/`file_url`, `model`, `language`, `diarize`, `timestamp_granularities`,
  `context_bias`) -> decode `{ text, language, segments }` into `TranscriptResult`.
- Map our `CommonTranscribeRequest` fields: `biasingTerms -> context_bias`,
  `wordTimestamps -> timestamp_granularities: ["word"]`, `diarization -> diarize`.

### 3c. `@effect-uai/voxtral` Realtime Transcriber (streaming)

- Reuse the OpenAI realtime pattern (`OpenAIRealtimeTranscriber.ts` +
  `realtimeStt.ts`): `Socket.fromWebSocket` with an auth-header WS constructor,
  a `Queue.make<TranscriptEvent, Cause.Done>()` drained as the output stream,
  audio forked in as binary frames, `Queue.end` on `TranscriptionStreamDone`.
- Apply the realtime memories: `closeCodeIsError: (code) => code !== 1000 && code !== 1001 && code !== 1005`
  (`project_socket_close_code`) and `Queue.end` not `Queue.shutdown`
  (`project_queue_end_vs_shutdown`).
- Event mapping -> `TranscriptEvent`:
  - `TranscriptionStreamTextDelta` -> `{ _tag: "partial", text }`
    (and/or `final` when `Done` arrives; confirm whether deltas are cumulative).
  - `TranscriptionStreamDone` -> `{ _tag: "final", text }` then end queue.
  - `RealtimeTranscriptionError` -> `{ _tag: "error", message }`.
  - `SessionCreated` -> `{ _tag: "metadata" }` (or drop).
- Wire input format: require `pcm_s16le @ 16000 mono`; `Unsupported` otherwise.
  Send `target_streaming_delay_ms` from a provider option (default ~300ms to match
  the recipe's utterance settle).
- Layer registers `VoxtralTranscriber`, generic `Transcriber`, and the
  `SttStreaming` capability marker.

### 3d. `@effect-uai/voxtral` Synthesizer (TTS)

- `synthesize`: POST `model`, `input`, `voice_id`/`ref_audio`, `response_format`
  -> decode base64 `audio_data` -> `AudioBlob` with the matching `AudioFormat`.
- `streamSynthesis` / `streamSynthesisFrom`: use the streaming TTS variant; emit
  `AudioChunk` per chunk. Prefer `pcm` (float32 LE) for lowest latency; expose
  `outputFormat` mapping `pcm -> { encoding: "pcm_f32le", sampleRate: 24000 }`
  (confirm sample rate), `mp3`, `wav`, `opus`.
- Map `CommonSynthesizeRequest.voiceId -> voice_id`. Add a provider-typed
  `VoxtralSynthesizeRequest` that also accepts `refAudio` for one-off cloning.
- Layer registers `VoxtralSynthesizer`, generic `SpeechSynthesizer`, and
  `TtsIncrementalText` (since `streamSynthesisFrom` is supported). No
  `MultiSpeakerTts` marker unless dialogue is implemented.

## 4. Voice-loop recipe: full Mistral pipeline

`recipes/voice-loop/` currently wires Google (STT+LLM) + ElevenLabs (TTS) through
the generic `Transcriber` / `LanguageModel` / `SpeechSynthesizer` tags, so swapping
providers is a Layer change, not a code change. Steps:

- Add `@effect-uai/mistral` + `@effect-uai/voxtral` to `recipes/package.json`.
- Add a Mistral `PipelineConfig` preset:
  - `stt.model = "voxtral-mini-transcribe-realtime-2602"`,
    `stt.inputFormat = pcm_s16le @ 16000 mono` (already the recipe default).
  - `llm.model = "mistral-small-latest"` (or medium).
  - `tts.model = "voxtral-mini-tts-2603"`, `tts.voiceId = <a stock voice id>`,
    `tts.outputFormat = pcm_f32le @ 24000 mono`.
- **Format bridge**: the recipe's playback worklet and `chunkDurationMs` assume
  `pcm_s16le`. Voxtral TTS pcm is float32 LE. Either (a) request a TTS format the
  player already supports, or (b) add an f32le->s16le step and update
  `chunkDurationMs` for 4-byte samples. Pick one and keep the pacing math correct.
- Provide layers: `Mistral.layer({ apiKey }) ++ Voxtral STT/TTS layers ++ HttpClient`.
  Add a `run-bun.ts`-level switch or env (`PROVIDER=mistral`) to select the preset.
- Keep the existing `phoneticize`/`settleBurst` logic unchanged.

## 5. Tests

- `Mistral` codec unit tests: history+tools -> wire body; canned SSE -> `TurnEvent`
  sequence (text deltas, a tool call, usage, `TurnComplete`); `tool_choice` and
  `response_format` mapping; error-status -> `AiError` mapping.
- `Voxtral` batch: multipart assembly + response decode (segments, words).
- `Voxtral` realtime: feed canned server frames through the decoder ->
  `TranscriptEvent` stream; close-code handling; `Queue.end` drains cleanly.
- `Voxtral` TTS: base64 decode -> `AudioBlob`; streaming chunks -> `AudioChunk`.
- Voice-loop: extend `index.test.ts` with the Mistral preset using fake layers.
- Type-level: `expectTypeOf` that `layer` yields both typed + generic tags and
  that requirements stay `HttpClient` (per `feedback_no_scratch_type_checks`).

## 6. Open items to confirm during implementation

- Exact realtime WebSocket URL/path and the JSON `type` discriminator per event
  (the SDK uses class names; confirm the wire `type` strings).
- Whether realtime text deltas are incremental or cumulative (affects partial vs
  final assembly).
- TTS streaming transport (SSE base64 chunks vs chunked binary) and the pcm sample
  rate (24000 assumed).
- Stock `voice_id` values available without a cloning upload.
- Confirm current chat model ids and `finish_reason` value set.

## Sources

- Chat completions / function calling: https://docs.mistral.ai/studio-api/conversations/function-calling , https://docs.mistral.ai/api
- Voxtral overview / news: https://mistral.ai/news/voxtral-transcribe-2/ , https://mistral.ai/news/voxtral-tts/
- Realtime STT: https://docs.mistral.ai/studio-api/audio/speech_to_text/realtime_transcription
- Batch STT endpoint: https://docs.mistral.ai/api/endpoint/audio/transcriptions
- TTS: https://docs.mistral.ai/studio-api/audio/text_to_speech/speech
