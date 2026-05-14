# Docs update — Speech, Voice loop, Music, Realtime

Goal: bring the docs site in line with what has actually shipped (sync + streaming `Transcriber`, sync + streaming `SpeechSynthesizer`, `MusicGenerator` with Lyria, capability markers, 6 cross-modal recipes) and shape the navigation around future modalities so the same shelves accept image / video / realtime when they land.

Style brief (matches existing docs): one-liner frontmatter description that names the user's problem, a single problem-framed opening sentence, then the smallest amount of structure that does the job. Tables for provider matrices, short code blocks, hard cross-links to recipes and provider pages. No marketing prose, no technology-first openings. Mirror the shape of [docs/concepts/language-model.md](../docs/concepts/language-model.md) and [docs/embeddings/index.md](../docs/embeddings/index.md).

---

## 1. Future-shaped section layout

User-perspective mapping — what shelf they look at when they have a use case:

| User question | Section |
| --- | --- |
| "Chat with an LLM, use tools, vision input" | Language models |
| "Search / cluster / classify by meaning" | Embeddings |
| "Transcribe a file or a live mic" | Speech → Transcription |
| "Read text aloud, low latency" | Speech → Synthesis |
| "Build a voice assistant" | Speech → Voice loop (flagship recipe) |
| "Generate a song from a prompt" | Music generation |
| "Generate an image" | Image generation (Soon) |
| "Generate a video" | Video generation (Soon) |
| "Re-rank top-K hits" | Reranking (Soon) |
| "Duplex session: model-native barge-in, camera-in, voice-out" | Realtime (Soon) |

The split that matters: **Speech for "one direction at a time"** (one-shot or streaming, but each call is in→out or out→in — including composed pipelines like voice-loop), **Realtime for "one session, both directions live"** with the future shape covering voice + camera in / voice + text out.

---

## 2. Page structure

```
docs/
  speech/                              ← NEW top-level group (out of "Coming soon")
    index.md                           REWRITE — overview: Transcriber + SpeechSynthesizer,
                                       two tags, capability markers. Opens with
                                       "Voice assistants are the canonical use case →
                                       Voice loop recipe" callout.
    transcription.md                   NEW — sync vs streaming STT, formats, providers
    synthesis.md                       NEW — sync, chunked, incremental TTS, LLM→TTS pipe
    providers/
      openai.md                        NEW
      elevenlabs.md                    NEW
      gemini.md                        NEW
      inworld.md                       NEW

  music-generation/                    ← Top-level (out of "Coming soon")
    index.md                           REWRITE — MusicGenerator service tag (Lyria today),
                                       sync + chunked, MusicInteractiveSession marker for
                                       bidi sessions (Lyria RealTime — not shipped yet)
    providers/
      gemini.md                        NEW — @effect-uai/google/LyriaGenerator

  realtime/                            ← RENAME from docs/realtime-audio/, stays under "Coming soon"
    index.md                           REWRITE — duplex sessions. Opens with "For voice
                                       assistants you can ship today, see Speech → Voice
                                       loop." Then defines what Realtime adds (model-native
                                       barge-in, server-side VAD, duplex tool calls,
                                       camera-in streams when providers ship). Names
                                       OpenAI Realtime + Gemini Live as candidates.

  recipes/
    index.md                           UPDATE — add Speech section (voice-loop first as
                                       flagship, then the 4 basic / streaming recipes),
                                       add Music section (basic-music-generation).
```

Speech recipe READMEs already exist and are picked up by [webpage/src/content.config.ts](../webpage/src/content.config.ts). No changes needed to them; only the docs and nav need wiring.

---

## 3. Page-by-page outline

Each outline is the **finished page structure** — what sections it has and what each section says in one sentence. Code blocks are illustrative.

### 3.1 `docs/speech/index.md` (REWRITE)

Frontmatter:
```
title: Speech
description: Two service tags — Transcriber and SpeechSynthesizer — that cross the audio boundary in either direction.
```

Opening: "Voice notes, captions, and read-aloud answers all cross the same boundary." (Problem-first.)

Sections:
- **Voice assistants** — pinned callout right under the H1: "Most users land here looking to build a voice assistant. The composed STT → LLM → TTS pipeline ships as the [Voice loop](/recipes/voice-loop/) recipe — stop-word interrupt, follow-up queueing, one fiber per turn." This is the *first* substantive section.
- **Two tags, one seam** — `Transcriber` for audio → text, `SpeechSynthesizer` for text → audio. Same portable-vs-typed-tag pattern as [`LanguageModel`](/concepts/language-model/). Switching providers is swapping a Layer.
- **The shape** — show the two service interfaces side-by-side abbreviated. Link out to the narrower pages.
- **Capability markers** — `SttStreaming` and `TtsIncrementalText` in one paragraph each. Phantom-marker pattern. Calling a streaming helper against a Layer that doesn't ship the marker is a *compile-time* error.
- **Provider matrix**:

  | Provider | STT sync | STT streaming | TTS sync | TTS chunked | TTS incremental-text |
  | --- | --- | --- | --- | --- | --- |
  | OpenAI | ✓ | ✓ (`OpenAIRealtimeTranscriber`) | ✓ | ✓ | — |
  | ElevenLabs | — | ✓ (Scribe v2 Realtime) | ✓ | ✓ | ✓ |
  | Gemini | ✓ (prompt-driven) | — | ✓ | — | — |
  | Inworld | ✓ | ✓ | ✓ | ✓ | ✓ |

- **Next step** — point at [Voice loop](/recipes/voice-loop/) first, then `basic-transcription` / `basic-speech-synthesis` for the primitives in isolation.
- **See also** — Transcription, Synthesis, providers, Realtime (planned).

Target length: ~120 lines.

### 3.2 `docs/speech/transcription.md` (NEW)

Frontmatter:
```
title: Transcription
description: Audio in, text out — one-shot for finished files, streaming for live mics.
```

Opening: "Caption a podcast, transcribe a meeting, or stream a live mic — they're the same call with different inputs."

Sections:
- **The shape** — `transcribe` (Effect<TranscriptResult>) and `streamTranscriptionFrom` (Stream<TranscriptEvent>). Show `CommonTranscribeRequest` and `CommonStreamTranscribeRequest`.
- **Sync — `transcribe`** — `audio: AudioSource` (URL / base64 / bytes), full text + optional word timestamps out. Short snippet.
- **Streaming — `streamTranscriptionFrom`** — `Stream<Uint8Array>` in (mic frames at declared `inputFormat`), `Stream<TranscriptEvent>` out. Mention `SttStreaming` required in R. Dual-arity (pipeable + data-first). 6-line snippet.
- **Audio format** — `inputFormat: { container, encoding, sampleRate, channels }` declared on the request; mismatches → `AiError.InvalidRequest` at startup. Most realtime providers want 16 kHz pcm s16le; OpenAI Realtime wants 24 kHz.
- **What you get back** — `TranscriptEvent` union (`partial`, `final`, `speech-started`, `utterance-ended`, `audio-event`, `metadata`, `error`); `TranscriptResult` for sync.
- **Next step** — `basic-transcription`, `streaming-transcription`, `voice-loop`.

### 3.3 `docs/speech/synthesis.md` (NEW)

Frontmatter:
```
title: Synthesis
description: Text in, audio out — one-shot, chunked, or token-streaming for low-latency TTS.
```

Opening: "Reading an answer aloud and starting playback before the model has finished writing are the same call with different inputs."

Sections:
- **Three modes** — `synthesize` (Effect<AudioBlob>), `streamSynthesis` (Stream<AudioChunk>, full text in / chunked audio out), `streamSynthesisFrom` (Stream<AudioChunk>, incremental text-in, gated by `TtsIncrementalText`). One short paragraph each.
- **The shape** — `CommonSynthesizeRequest` + `CommonStreamSynthesizeRequest`. Note `voiceId: string` here; each provider's typed request narrows to a literal union plus a `(string & {})` escape for custom cloned voices (or stock-only where there's no clone path, e.g. OpenAI).
- **Output format** — `outputFormat` on the request; falls back to provider default. Most streaming TTS is PCM s16le at 24 / 48 kHz; ElevenLabs additionally supports MP3.
- **LLM → TTS** — the canonical pipe from `LanguageModel.streamTurn` through `Turn.textDeltas` into `SpeechSynthesizer.streamSynthesisFrom`. ~8-line snippet — this is what `streamSynthesisFrom` exists for.
- **Next step** — `basic-speech-synthesis`, `streaming-synthesis`, `voice-loop`.

### 3.4 `docs/speech/providers/*.md` (4 NEW)

Same shape as [docs/providers/gemini.md](../docs/providers/gemini.md). Each page: `title` + `description`, Install, Layers (which subpaths register what + which capability markers), Models table, Provider-specific request fields, Wire / auth notes that surprise users.

Notes that must appear:

- **`openai.md`** — sync STT via `OpenAITranscriber` (`whisper-1` is the *only* model that supports `wordTimestamps: true`). Streaming STT lives at `OpenAIRealtimeTranscriber` subpath because it uses the `ws` peer dep to set `Authorization` + `OpenAI-Beta: realtime=v1` headers (browser-WebSocket can't set headers). TTS via `OpenAISynthesizer` — sync + chunked HTTP; **no `TtsIncrementalText` marker** (OpenAI has no incremental-text-in TTS).
- **`elevenlabs.md`** — streaming STT (Scribe v2 Realtime, 16 kHz pcm s16le, browser-friendly via single-use token in `?token=…` query param — no special peer deps). Full TTS pipeline incl. `streamSynthesisFrom` (Flash v2.5 model = sub-100 ms first-byte). Voice IDs are 20-char opaque slugs; same shape for stock + cloned.
- **`gemini.md` (speech)** — sync STT is **prompt-driven** on top of multimodal Gemini models, *not* a dedicated endpoint: `wordTimestamps: true` / `diarization: true` fail with `AiError.Unsupported`. TTS is sync-only (no `TtsIncrementalText` marker, no `streamSynthesis` either) with ~30 prebuilt voices (`Kore`, `Puck`, …); no SSML, no speed/pitch knobs — prosody via natural-language prompt tags. Notes that this page is the **speech** Gemini page — language-model Gemini lives at [/providers/gemini/](/providers/gemini/).
- **`inworld.md`** — first-party `inworld/inworld-stt-1` plus router-style passthroughs to AssemblyAI / Soniox / Groq Whisper through the same Inworld key. Both streaming markers shipped. TTS `inworld-tts-2` adds `deliveryMode` (`STABLE` / `BALANCED` / `CREATIVE`) — ignored silently by older models. WS auth via short-lived JWT (`wsAuth.ts`).

Target length: ~100 lines per page.

### 3.5 `docs/music-generation/index.md` (REWRITE)

Frontmatter:
```
title: Music generation
description: Prompt → music. Sync, chunked, or bidirectional interactive sessions (with the right provider).
```

Opening: "A short text prompt, a 30-second clip, no fixture audio." (Problem-first.)

Sections:
- **The shape** — `MusicGenerator` service tag with three methods: `generate` (sync, Effect<MusicResult>), `streamGeneration` (Stream<AudioChunk> — async/poll-based providers like Lyria 3 sync emit a single chunk; bidi-capable providers stream natively), `streamGenerationFrom` (bidi: Stream<MusicSessionInput> in, Stream<AudioChunk> out — gated by `MusicInteractiveSession`).
- **Capability marker** — `MusicInteractiveSession` for bidirectional updates (Lyria RealTime via the `BidiGenerateMusic` WebSocket). Today no provider Layer ships it; calling `streamGenerationFrom` is a compile-time error until that lands.
- **Provider matrix** (small — just Google today):

  | Provider | Sync | Chunked stream | Bidi session |
  | --- | --- | --- | --- |
  | Google Lyria | ✓ (clip + pro) | ✓ (single-chunk emul.) | — (planned: Lyria RealTime) |

- **Next step** — [basic-music-generation](/recipes/basic-music-generation/).

Target length: ~80 lines.

### 3.6 `docs/music-generation/providers/gemini.md` (NEW)

Same shape as the LM Gemini provider page. Specifically:

- Layer: `@effect-uai/google/LyriaGenerator` registers `LyriaGenerator` typed tag + `MusicGenerator` generic tag. Does **not** ship `MusicInteractiveSession`.
- Models: `lyria-3-clip-preview` (30s, MP3) and `lyria-3-pro-preview` (longer, MP3 / WAV).
- Note that `bpm`, `scale`, `instrumental`, weighted prompts are **flattened into the prompt text** for Lyria 3 sync — there's no structured weighted-prompt field on the public REST endpoint. Lyria RealTime exposes these as structured updates; that path isn't shipped here.
- SynthID watermark always present on `result.watermark`.

Target length: ~70 lines.

### 3.7 `docs/realtime/index.md` (RENAME + REWRITE)

`git mv docs/realtime-audio/ docs/realtime/` to preserve history. Rewrite the page:

- Frontmatter description: "Duplex sessions — model-native barge-in, server-side VAD, voice + camera in / voice + text out."
- Opening: "For voice assistants you can ship today, see [Speech → Voice loop](/recipes/voice-loop/)." (Acknowledge upfront.)
- "What Realtime adds" — model-native barge-in, server-side VAD interrupting the response, duplex tool-calls mid-utterance, camera-in streams when providers ship. The voice-loop pipeline approximates this through composition but doesn't have those four properties.
- Provider candidates: OpenAI Realtime (WS + WebRTC), Google Gemini Live (multimodal in / audio out).
- Stays under "Coming soon" with `Soon` badge until the first `RealtimeSession` integration lands.

### 3.8 `docs/recipes/index.md` (UPDATE)

Add two new sections to the existing recipe table. **Voice loop is listed first in Speech** as the flagship.

```
## Speech

| Recipe                                                       | One-line                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [Voice loop](/recipes/voice-loop/)                           | Full STT → LLM → TTS pipeline with stop-word interrupt and follow-up queueing; one fiber per turn.      |
| [Basic transcription](/recipes/basic-transcription/)         | Transcribe a file via the generic Transcriber service; swap providers with `--provider`.                |
| [Basic speech synthesis](/recipes/basic-speech-synthesis/)   | Synthesize a phrase via the generic SpeechSynthesizer service; sync or chunked-streaming.               |
| [Streaming transcription](/recipes/streaming-transcription/) | Live mic → transcript over WebSocket; Bun server bridges browser AudioWorklet to provider realtime.     |
| [Streaming synthesis](/recipes/streaming-synthesis/)         | Type text → audio plays as the first chunk arrives; incremental text-in over WS.                        |

## Music

| Recipe                                                       | One-line                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [Basic music generation](/recipes/basic-music-generation/)   | Generate a 30-second clip with Lyria 3; simple prompt or weighted prompts with lyrics and BPM hints.    |
```

### 3.9 Sidebar — [webpage/astro.config.mjs](../webpage/astro.config.mjs)

- Remove `Speech` and `Realtime audio` from "Coming soon".
- Add **Speech** as a top-level group between "Embeddings" and "Migrations":

  ```js
  {
    label: "Speech",
    items: [
      { label: "Overview", slug: "speech" },
      { label: "Transcription", slug: "speech/transcription" },
      { label: "Synthesis", slug: "speech/synthesis" },
      {
        label: "Providers",
        items: [
          { label: "OpenAI", slug: "speech/providers/openai" },
          { label: "ElevenLabs", slug: "speech/providers/elevenlabs" },
          { label: "Google Gemini", slug: "speech/providers/gemini" },
          { label: "Inworld", slug: "speech/providers/inworld" },
        ],
      },
      {
        label: "Recipes",
        collapsed: true,
        items: [
          { label: "Voice loop", slug: "recipes/voice-loop" },
          { label: "Basic transcription", slug: "recipes/basic-transcription" },
          { label: "Basic speech synthesis", slug: "recipes/basic-speech-synthesis" },
          { label: "Streaming transcription", slug: "recipes/streaming-transcription" },
          { label: "Streaming synthesis", slug: "recipes/streaming-synthesis" },
        ],
      },
    ],
  },
  ```

- Add **Music generation** as a top-level group right after Speech:

  ```js
  {
    label: "Music generation",
    items: [
      { label: "Overview", slug: "music-generation" },
      {
        label: "Providers",
        items: [{ label: "Google Lyria", slug: "music-generation/providers/gemini" }],
      },
      {
        label: "Recipes",
        collapsed: true,
        items: [{ label: "Basic music generation", slug: "recipes/basic-music-generation" }],
      },
    ],
  },
  ```

- Rename `slug: "realtime-audio"` → `slug: "realtime"` and label "Realtime audio" → "Realtime" in the "Coming soon" group (keep the `Soon` badge).

### 3.10 Landing page recipes — [webpage/src/components/RecipesSection.tsx](../webpage/src/components/RecipesSection.tsx)

Append a **Voice loop** card to the `recipes` array. Description: "**Talk to your agent.** Streaming STT, LLM, and TTS composed as Effect fibers; stop-words interrupt mid-sentence." Icon: `PiMicrophone` (already supported by react-icons/pi).

Don't touch `FeaturesSection.tsx` — speech is a capability, not a harness feature. One recipe card is the right surface.

### 3.11 Root README — [README.md](../README.md)

- Extend packages table:
  - Update `@effect-uai/google` description to mention Gemini LM + speech (Transcriber, Synthesizer) + Lyria music.
  - Add three rows: `@effect-uai/openai` (Transcriber sync + realtime, Synthesizer), `@effect-uai/elevenlabs` (Transcriber realtime, Synthesizer with `streamSynthesisFrom`), `@effect-uai/inworld` (Transcriber + Synthesizer, sync + realtime).
- Extend repo-layout tree with the five speech recipes + the music recipe.

---

## 4. Order of work

1. [x] Confirm structure (done — this revision).
2. Write `docs/speech/index.md` (overview).
3. Write `docs/speech/transcription.md` and `docs/speech/synthesis.md` (parallel-safe).
4. Write the four `docs/speech/providers/*.md` pages (parallel-safe).
5. Rewrite `docs/music-generation/index.md`.
6. Write `docs/music-generation/providers/gemini.md`.
7. `git mv docs/realtime-audio docs/realtime` and rewrite the index.
8. Update `docs/recipes/index.md` (Speech + Music sections).
9. Update `webpage/astro.config.mjs` sidebar.
10. Update `webpage/src/components/RecipesSection.tsx` (Voice loop card).
11. Update root `README.md` (packages table + recipe tree).
12. `pnpm -F webpage build` and click-through all new internal links.
