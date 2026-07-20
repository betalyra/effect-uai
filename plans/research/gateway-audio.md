# Research: OpenRouter / Requesty audio, and how standardized STT/TTS actually is

Subagent report, gathered 2026-07-15. VERIFIED = confirmed against first-party
docs/specs. Absence of evidence is called out as such.

**Both gateways ship audio endpoints, but they differ sharply in ambition.**

## Part A: OpenRouter, all four surfaces exist

OpenRouter announced dedicated audio APIs on **2026-05-01**
([blog](https://openrouter.ai/blog/announcements/announcing-audio-apis/)).

**1. TTS. VERIFIED.** `POST /api/v1/audio/speech`
([docs](https://openrouter.ai/docs/guides/overview/multimodal/tts.md))

- Params: `model`, `input`, `voice` (all required); `response_format`, `speed`
  (default 1.0), `provider` (optional)
- Response: raw audio byte stream + `X-Generation-Id` header
- OpenAI-shaped. Docs state "fully compatible with the OpenAI SDK", streaming via
  `with_streaming_response`
- Models: `openai/gpt-4o-mini-tts-2025-12-15`, `mistralai/voxtral-mini-tts-2603`,
  `microsoft/mai-voice-2`
- **Divergence**: formats are only `mp3` | `pcm` (OpenAI's own API offers six), and
  default is `pcm`, not OpenAI's `mp3`.

**2. STT. VERIFIED.** `POST /api/v1/audio/transcriptions`
([docs](https://openrouter.ai/docs/guides/overview/multimodal/stt.md))

- **Two request paths**: OpenAI-style `multipart/form-data` (`file`, `model`,
  `language`, `temperature`, `response_format`, `timestamp_granularities`), _or_ a
  custom JSON path with `input_audio.data` (base64) + `input_audio.format`. The
  JSON path is OpenRouter's own invention, not OpenAI-shaped.
- Response: `{ text, usage: { seconds, total_tokens, input_tokens, output_tokens, cost } }`.
  The `usage` block is a superset of OpenAI's.
- **Two leaks in the abstraction, both explicit in docs**: `prompt` is _accepted but
  ignored_, and `verbose_json` (task/language/duration/segments, word timestamps)
  works **only on OpenAI-compatible providers (OpenAI, Groq, Together)**. That is a
  gateway admitting it cannot normalize.

**3. Dedicated endpoints vs chat-embedded audio: both exist, separately.**
([audio.md](https://openrouter.ai/docs/guides/overview/multimodal/audio.md))
Chat-embedded audio input uses
`{"type": "input_audio", "input_audio": {"data": "<base64>", "format": "wav"}}`
content parts on `/api/v1/chat/completions` (formats: wav, mp3, aiff, aac, ogg,
flac, m4a, pcm16, pcm24; e.g. `google/gemini-2.5-flash`). Genuinely different
surface from the dedicated endpoints, which the docs pitch as "faster and more
cost-efficient" for specialized models.

**4. Chat audio output. VERIFIED.** `modalities: ["text","audio"]` +
`audio: {voice, format}` on chat completions, voices
alloy/echo/fable/onyx/nova/shimmer, formats wav/mp3/flac/opus/pcm16, deltas via
`delta.audio`. Example model `openai/gpt-4o-audio-preview`.

**5. Model collections.** [llms.txt](https://openrouter.ai/docs/llms.txt) lists
dedicated STT/TTS/audio guide pages plus per-language SDK modules (`sdks/tts`,
`sdks/stt` for TS/Python/Go). Distinct model collections:
[text-to-speech-models](https://openrouter.ai/collections/text-to-speech-models)
(Gemini 3.1 Flash TTS, Kokoro 82M, Grok Voice TTS 1.0, MAI-Voice-2, Voxtral Mini
TTS, Orpheus 3B, CSM 1B, Zonos v0.1) and
[speech-to-text-models](https://openrouter.ai/collections/speech-to-text-models).
Note: the API-reference URL surfaced by search
(`/docs/api/api-reference/tts/create-audio-speech`) **404s**, stale search index.

## Part B: Requesty, real but OpenAI-only passthrough

**1. VERIFIED** against the live spec (fetched
`https://docs.requesty.ai/api-reference/openapi.json`, 175KB). Both
`/v1/audio/speech` and `/v1/audio/transcriptions` exist, server
`https://router.requesty.ai`, operationIds `createSpeech` / `createTranscription`.
Prose docs also exist
([speech](https://docs.requesty.ai/api-reference/endpoint/audio-speech-create.md),
[transcription](https://docs.requesty.ai/api-reference/endpoint/audio-transcriptions-create.md))
with curl/Python/TS examples, so this is **not** just a spec entry.

**2. Shapes: asymmetric, and this is the key finding.**

`SpeechRequest` is a **faithful OpenAI clone**: `model`/`input` (max 4096)/`voice`
required; voice is a closed enum of OpenAI's 11 (alloy…verse); plus
`instructions`, `response_format` (mp3/opus/aac/flac/wav/pcm, default mp3), `speed`
(0.25–4.0), `stream_format` (`sse` → `speech.audio.delta`/`speech.audio.done`).

`TranscriptionMultipartRequest` is a **strict subset**: only `file`, `model`,
`language`. **No `prompt`, no `response_format`, no `timestamp_granularities`, no
`temperature`.** `TranscriptionResponse` is just `{ text, usage }`. So there is no
`verbose_json`, no segment or word timestamps at all.

**3. Not a cross-provider interface.** Both schemas say verbatim: _"Currently only
OpenAI models are supported"_: `openai/gpt-4o-mini-tts`, `openai/tts-1`,
`openai/tts-1-hd` for speech; `openai/gpt-4o-transcribe` for transcription. Docs
confirm _"Today the available speech models are all from OpenAI."_ It's OpenAI
passthrough with routing/billing/key-management on top. No normalization claims,
there's nothing to normalize yet. Requesty's audio surface is roughly one
generation behind OpenRouter's.

## Part C: How standardized? A two-tier answer

**1. `/v1/audio/*` is a real but much weaker standard than `/v1/chat/completions`.**

Verified implementers of the exact paths: Groq
(`api.groq.com/openai/v1/audio/transcriptions`,
[docs](https://console.groq.com/docs/speech-to-text)), Mistral
([`/v1/audio/transcriptions`](https://docs.mistral.ai/api/endpoint/audio/transcriptions)),
vLLM (transcriptions + translations,
[docs](https://docs.vllm.ai/en/latest/serving/online_serving/speech_to_text/)),
OpenRouter, Requesty, LLM Gateway. Together and Fireworks are named as compatible
by third parties ([LiteLLM](https://docs.litellm.ai/docs/audio_transcription) lists
`fireworks_ai`; OpenRouter names Together among verbose_json-capable providers),
**not verified against first-party docs**.

The asymmetry is stark: **transcription compatibility is common, speech (TTS)
compatibility is rare.** vLLM implements `/v1/audio/transcriptions` but there is
**no evidence of `/v1/audio/speech`** (absence of evidence, though suggestive given
it's an LLM server). Requesty implements speech OpenAI-only. Fireworks' streaming
transcription is its own binary-frame WebSocket protocol (PCM16/16kHz/mono), _not_
OpenAI-shaped.

**Could NOT verify** (searches returned nothing first-party): Ollama audio
endpoints, Azure OpenAI audio paths. Azure is widely believed to mirror OpenAI's
paths under deployment-based routing, but this is **unverified inference**.

**2. Divergence concentrates exactly where the value is.** Streaming TTS (SSE deltas
vs raw bytes vs WebSocket), realtime, word-level timestamps, diarization, voice ids,
formats. OpenAI's `/v1/audio/speech` has no concept of a voice _library_: `voice` is
a short closed enum. That single design choice is why ElevenLabs cannot be squeezed
into the shape without loss.

**3. No, there is no "openai-compatible" consensus for audio.** The serious TTS/STT
vendors are each their own protocol, verified:

- **ElevenLabs**: voice-id-in-path REST (`/v1/text-to-speech/{voice_id}`), plus
  `/v1/text-to-speech/{voice_id}/stream-input` WebSocket with
  `chunk_length_schedule`, voice settings handshake, word-level alignment
  ([docs](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)).
  Structurally unmappable to `voice: "alloy"`.
- **Deepgram**: native `/v1/listen` (STT) and `/v1/speak` (TTS), own params
  (`diarize_model`), own auth
  ([docs](https://developers.deepgram.com/docs/diarization)). Deepgram's OpenAI
  surface is a _product_ (Whisper Cloud), not protocol compatibility.
- **Cartesia / Inworld**: **no evidence** of OpenAI-compatible audio endpoints.
  Unconfirmed rather than disproven; first-party docs not fetched.

The tell: gateways reach these vendors only via **compatibility layers they wrote
themselves** (LLM Gateway fronting ElevenLabs behind `/v1/audio/speech`), never via
native compatibility.

**4. LiteLLM normalizes the floor, not the ceiling.**
([speech](https://docs.litellm.ai/docs/text_to_speech),
[transcription](https://docs.litellm.ai/docs/audio_transcription))

- TTS: OpenAI, Azure, Vertex AI, AWS Polly, ElevenLabs, MiniMax
- STT: `openai, azure, vertex_ai, gemini, deepgram, groq, fireworks_ai, ovhcloud, mistral`
- Exposes unified `speech()`/`aspeech()`/`transcription()` and an OpenAI-compatible
  `/audio/speech`; cost tracking / fallbacks / load balancing do work across providers.
- **But the normalization is shallow, and LiteLLM's own docs show where it breaks**:
  `voice` is _not_ normalized (OpenAI `"alloy"` vs Vertex `"en-US-Wavenet-D"`). It's
  a bare string passed through. Gemini TTS is _bridged_ from chat-completions models
  into the `/audio/speech` shape. Each provider gets its own doc page for the parts
  that don't fit.

## Synthesis

Three independent implementations (LiteLLM, OpenRouter, Requesty) converged on the
same compromise, which is strong evidence it's the real ceiling rather than three
separate cases of laziness:

**`{model, input, voice} → bytes` and `{file, model} → {text}` normalize cleanly.
Everything past that is provider-typed or dropped.** OpenRouter drops `prompt` and
gates `verbose_json` by provider. Requesty ships transcription with three fields
total. LiteLLM leaves `voice` as an unvalidated passthrough string.

For effect-uai: the "don't unify what isn't unified" rule applies hard here. `voice`
in particular looks shared and is not: an OpenAI enum, a Vertex Wavenet id, and an
ElevenLabs library UUID are three different kinds of thing wearing one field name.
The OpenRouter/Requesty finding also supports "provider packages scope to one API
surface": a gateway's `/v1/audio/speech` is a genuinely different capability from
ElevenLabs' WebSocket TTS, not a config difference. The common request can honestly
promise text-in/audio-out and audio-in/text-out; timestamps, diarization, and voice
identity should stay provider-typed.
