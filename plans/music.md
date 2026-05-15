# Music generation — provider research & interface design

Planning doc for adding a music-generation provider abstraction to `effect-uai`, sibling to `Transcriber` (STT) and `SpeechSynthesizer` (TTS). Mirrors the design language and capability-marker pattern established in [stt-tts.md](./stt-tts.md).

## Goal

Cross-provider music generation with three execution modes:

1. **Sync** — prompt in, full audio file out. The baseline every provider supports.
2. **Streaming output** — prompt in, audio chunks streamed back as they're generated. Reduces time-to-first-sample for long compositions.
3. **Interactive session** — bidirectional: continuously stream new/updated weighted prompts and config (BPM, density, brightness, scale) and receive a continuous audio stream that adapts in real time. Currently Lyria RealTime is the only provider here.

## In scope / out of scope

In scope

- Text-prompt-to-audio (single prompt or weighted prompt list).
- Lyrics + style conditioning (vocals).
- Instrumental-only mode.
- Optional structured controls when widely shared (BPM, scale, duration hint, mood/genre keywords) — and provider-extension fields for everything else.
- Bidirectional interactive sessions where the provider supports them (Lyria RealTime).

Out of scope (consistent with stt-tts plan)

- Voice cloning / custom voice training APIs. (`voiceId: string` reference is fine; upload-to-clone is not.)
- Stem separation post-processing.
- Music continuation / extension from a reference clip — **deferred to a follow-up phase**. Per scoping decision, the v1 interface should be designed so that continuation can be added without a breaking change (likely a new `reference?: AudioSource` field on the request), but no provider adapter implements it yet.
- DAW-style track / clip editing APIs (Udio remix, Mureka multi-section editing).
- Watermark removal (Lyria embeds SynthID — we expose its presence in result metadata, not remove it).

---

# Provider landscape (2026)

Snapshot of providers and their wire-level shapes. Where a provider has multiple ways in (Vertex AI vs Gemini API, raw vs partner-API), the **canonical** entry below is the one that matches `effect-uai`'s HTTP-first / cross-runtime priorities.

## Google Lyria 3 (Gemini API)

Two product surfaces, same provider, different transports.

### Lyria 3 — sync (`generateContent`)

- Models: `lyria-3-clip-preview` (fixed 30s, MP3), `lyria-3-pro-preview` (up to ~3 min, MP3 or WAV).
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. Auth: `x-goog-api-key`.
- Request: `{ contents: [{ parts: [{ text }, ...] }], generationConfig: { responseModalities: ["AUDIO", "TEXT"], responseFormat: { audio: { mimeType: "audio/mp3" | "audio/wav" } } } }`. Up to 10 inline images alongside text.
- Prompt features: genre, instruments, song structure, **lyrics with `[Verse]`/`[Chorus]`/`[Bridge]`/`[Outro]` section tags**, vocals direction, key/scale, mood, duration hints, BPM, in-song timestamps (`[0:00 - 0:10] Intro…`).
- Response: `candidates[0].content.parts[0].inlineData.data` (base64 MP3/WAV at 44.1 kHz stereo). Text parts may include generated lyrics and structure JSON.
- Watermark: all output carries SynthID.
- **Not in the public API**: BPM/density/brightness/scale/temperature/top_k as structured fields (only via prompt text), streaming, continuation.

### Lyria RealTime — bidirectional WebSocket

- Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic`. ([API reference](https://ai.google.dev/api/live_music))
- Protocol: persistent bidi WS. Client→server messages: `setup` (first, `{ model }`), `client_content` (`{ weightedPrompts: [{ text, weight }] }`), `music_generation_config` (any subset of `temperature`, `topK`, `seed`, `guidance`, `bpm`, `density`, `brightness`, `scale`, `muteBass`, `muteDrums`, `onlyBassAndDrums`, `musicGenerationMode`), `playbackControl` (`PLAY` / `PAUSE` / `STOP` / `RESET_CONTEXT`).
- Server→client: `setupComplete`, `serverContent: { audioChunks: [{ data: bytes, mimeType: "audio/wav", sourceMetadata }] }`, `filteredPrompt`, `warning`.
- Bumping `bpm` or `scale` is a discontinuity — caller must follow with `RESET_CONTEXT`.
- Prompt weighting: blend influences (`{text: "minimal techno", weight: 1.0}` + `{text: "1980s synthwave", weight: 0.3}`).

## Suno

Most-used consumer music product. v5.5 (March 2026) supports up to 12-stem export and is widely considered the strongest "song with vocals" output.

- **No official public API as of May 2026.** Suno operates a partner program; everything else on the market (`sunoapi.org`, `suno.gcui.ai`, PiAPI, AIMLAPI, …) is reverse-engineered.
- Canonical 3rd-party shape: `POST /api/generate` (prompt or custom mode with lyrics + style), returns `taskId`; poll `GET /api/get?ids=…` until `status: complete`, then download `audio_url`. Streaming variant delivers the first audio chunk after ~20s.
- Features: prompt mode (single text → song), custom mode (lyrics text + style + title), music extension, stem export (v5+), instrumental-only.

→ Defer Suno until either (a) an official API ships or (b) the user explicitly wants to bet on a specific aggregator (e.g. `sunoapi.org`, AIMLAPI). When we do ship a Suno adapter, the natural design is a thin Layer parameterized over `{ baseUrl, apiKey }` so the user picks their aggregator.

## ElevenLabs Music

- [Eleven Music docs](https://elevenlabs.io/docs/overview/capabilities/music). Trained on data licensed via Merlin Network + Kobalt → favored by commercially-sensitive shipping products.
- Endpoints:
  - `POST /v1/music/compose` — prompt **or** composition plan in, full audio out. `duration_ms` between 3000 and 600000.
  - `POST /v1/music/compose-detailed` — composition plan with `respect_sections_durations` boolean.
  - `POST /v1/music/create-composition-plan` — generate a composition plan from a prompt (planner step you can call before compose).
  - `POST /v1/music/stream` — streaming audio output.
  - `POST /v1/music/upload` (March 2026) — upload an audio file and optionally extract a composition plan from it. Out of scope (uploads).
- Response surfaces `song_id` for back-reference.

## Mureka

- Endpoint: `POST https://api.mureka.ai/v1/song/generate`. Returns a `task_id`; poll `GET /v1/song/query/{task_id}` until done.
- Each generation produces **two** songs; avg ~45s. Up to 5 minutes per song. Up to 10 parallel generations per account; wait ≥3s between calls.
- Has dedicated `music/create-instrumental` and `music/create-advanced` variants.
- MusiCoT ("Music Chain-of-Thought") plans structure before audio — internal to the model, not user-controlled.

## MiniMax Music

- [Docs](https://platform.minimax.io/docs/api-reference/music-generation). Already on our roadmap for TTS (`@effect-uai/minimax`) — natural to add music in the same package.
- Models: `music-2.6` (recommended), `music-cover` (cover from reference), `music-2.6-free`, `music-cover-free`. Music 2.5+ adds multi-instrument arrangement.
- Sync `POST` with prompt and optional `lyrics`; when `lyrics_optimizer: true` and `lyrics` is empty, the system auto-generates lyrics from the prompt. `instrumental: true` skips lyrics entirely.
- Response: audio URL valid for 24 h.

## Stable Audio 2.5

- Stability AI's commercially-safe music model. Up to 190 s long-form. $0.20 per output audio.
- Used heavily by digital-product teams that need licensing safety.
- API surface lives on Stability's standard `stability.ai` endpoints — sync only.

→ Worth a Phase 2/3 adapter alongside ElevenLabs as the second "commercially-safe" option.

## Udio

- Strong on remix / post-generation editing (natural-language commands modify specific sections). 48 kHz output, stem support.
- No official public API — partner program only. Same situation as Suno.

→ Deferred behind the same gate as Suno.

## OpenAI

- **No music generation API as of May 2026.** Historical models (MuseNet, Jukebox) were research demos, never productionized.
- Reports (TechCrunch Oct 2025) and a confirmed audio model launch (~end of March 2026) hint at music capabilities, but the surface is unconfirmed — possibly ChatGPT-only.

→ Watch and re-evaluate. No adapter planned.

## Aggregators (out of scope as first-class providers, useful for Suno/Udio)

- **fal.ai** — hosts Lyria, MiniMax Music, Stable Audio, MusicGen, etc. behind a unified fal-API shape.
- **AIMLAPI** — same idea.
- **Replicate** — hosted MusicGen / Stable Audio / open-source models.

These can be modeled as a separate `@effect-uai/fal` / `@effect-uai/replicate` package later. Out of scope here.

## Provider summary table

| Provider             | Sync                        | Streaming output          | Interactive (mid-session prompts)        | Lyrics + vocals           | Custom voice / artist | Wire transport           |
| -------------------- | --------------------------- | ------------------------- | ---------------------------------------- | ------------------------- | --------------------- | ------------------------ |
| **Lyria 3 (Gemini)** | ok (`generateContent`)      | n/a (sync only)           | n/a                                      | via prompt + section tags | no                    | HTTP / JSON              |
| **Lyria RealTime**   | (emulated — collect stream) | ok (audio chunks over WS) | ok (`WeightedPrompt[]` + config updates) | no (instrumental only)    | no                    | WebSocket (bidi)         |
| **ElevenLabs Music** | ok (`compose`)              | ok (`stream`)             | no                                       | ok (composition plan)     | no                    | HTTP / JSON + chunked    |
| **Mureka**           | ok (poll → URL)             | no                        | no                                       | required (lyrics input)   | no                    | HTTP / JSON (async/poll) |
| **MiniMax Music**    | ok                          | no                        | no                                       | ok                        | no                    | HTTP / JSON              |
| **Stable Audio 2.5** | ok                          | no                        | no                                       | no (instrumental)         | no                    | HTTP / JSON              |
| **Suno (3rd-party)** | ok (poll)                   | ok (≥v5)                  | no                                       | ok                        | v5.5 cloning (oos)    | HTTP / JSON (async/poll) |
| **Udio (partner)**   | ok                          | n/a                       | no                                       | ok                        | no                    | HTTP / JSON              |
| **OpenAI**           | —                           | —                         | —                                        | —                         | —                     | (no public API)          |

---

# Service design

## Recommendation: separate `MusicGenerator` service

**Rationale**:

1. **Input model differs sharply from TTS.** `SpeechSynthesizer.synthesize` takes `{ text, voiceId, audioConfig }`. Music takes `{ prompts: WeightedPrompt[] | string, lyrics?, bpm?, scale?, genre?, mood?, durationSeconds?, instrumental? }`. Squashing both behind one service forces a union request type that's painful to use.
2. **Capability profile is disjoint.** TTS providers (OpenAI, Cartesia, Deepgram, MiniMax) don't do music; music providers (Suno, Mureka, Udio, Lyria) don't do TTS. The single ElevenLabs overlap is two different endpoints — easy to ship two adapter modules from one package (`@effect-uai/elevenlabs/Synthesizer` vs `@effect-uai/elevenlabs/MusicGenerator`).
3. **Semantics differ.** TTS is "render this text in this voice." Music is "compose audio from these intents." Voice IDs vs. weighted-prompt blends don't share a meaningful abstraction.
4. **Domain types are reusable, not the service shape.** `AudioBlob`, `AudioChunk`, `AudioFormat`, `AudioMimeType`, `AudioSource` all carry over unchanged. We only add a music-specific request type and a `MusicResult` (which extends `AudioBlob` with metadata: `lyrics?`, `sections?`, `songId?` for back-reference).

A `MusicGenerator` service slots in next to `Transcriber` and `SpeechSynthesizer` in `packages/core`, reuses every audio primitive, and avoids type-level union churn.

(Alternative considered: extend `SpeechSynthesizer` with `synthesizeMusic` / `streamMusic`. Rejected — the request shapes are wholly disjoint, the providers are disjoint, and capability markers would have to grow new combinations like "TTS-but-not-music" vs "music-but-not-TTS" that map cleanly onto the marker pattern only by service separation.)

## Capability markers

Following the same pattern as `SttStreaming` / `TtsIncrementalText` ([core/src/transcriber/Transcriber.ts](packages/core/src/transcriber/Transcriber.ts), [core/src/speech-synthesizer/SpeechSynthesizer.ts](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts)):

- **`MusicInteractiveSession`** — provided by Layers that support bidirectional sessions with mid-stream prompt/config updates. Currently only Lyria RealTime. Required in `R` for `streamGenerationFrom`.

**Not making it a marker:**

- Streaming output (`streamGeneration`) — every provider can deliver `Stream<AudioChunk>`, even if some only emit one chunk after the full blob lands. Cheap to emulate, not worth a compile-time gate.
- Lyrics support — most providers accept lyrics. Lyria 3 takes them inline in the prompt; Suno / Mureka / ElevenLabs / MiniMax take them as a structured field. We surface `lyrics?: string` in the common request and provider adapters route them appropriately. Lyria RealTime (instrumental only) — if you set `lyrics`, the adapter ignores it (warning at log level) rather than failing. Not a marker; mismatch is the user's concern via reading docs / capabilities metadata.
- Instrumental-only — `instrumental?: boolean` flag on the request, default `false`. Providers that don't differentiate (Lyria 3 — controlled via prompt phrasing) get a wrapper that prepends `"instrumental, no vocals."`.

## Function signatures

Mirroring the TTS pattern. All types reuse `AudioBlob`, `AudioChunk`, etc. from `packages/core/src/domain/Audio.ts`.

```ts
// packages/core/src/domain/Music.ts

/** A prompt fragment with a relative weight. Lyria-RealTime native; for single-prompt providers we sum/normalize to text. */
export interface WeightedPrompt {
  readonly text: string
  /** Default 1.0. Range typically [0, 1]; provider-dependent. */
  readonly weight?: number
}

/** Common request fields supported by most providers. Provider-specific extras live in `providerOptions`. */
export interface CommonGenerateMusicRequest {
  /** Either a single prompt string or weighted prompts (blended where supported). */
  readonly prompts: string | ReadonlyArray<WeightedPrompt>
  /** Lyrics text, optionally with section tags like `[Verse]` / `[Chorus]`. Ignored for instrumental-only providers / instrumental:true requests. */
  readonly lyrics?: string
  /** Target duration in seconds. Provider may treat as a hint or hard limit. */
  readonly durationSeconds?: number
  /** Beats per minute (60–200 typical). */
  readonly bpm?: number
  /** Musical key/mode hint — provider-specific vocabulary (e.g. "C_MAJOR", "A_MINOR"). */
  readonly scale?: string
  /** Skip vocals / lyrics. */
  readonly instrumental?: boolean
  /** Preferred output format. Provider may override. */
  readonly format?: AudioFormat
  /** Provider-namespaced escape hatch. */
  readonly providerOptions?: Record<string, unknown>
}

export interface CommonStreamGenerateMusicRequest extends CommonGenerateMusicRequest {}

/** Bidirectional session input — a stream of prompt-or-config updates. */
export type MusicSessionInput =
  | { readonly _tag: "prompts"; readonly prompts: ReadonlyArray<WeightedPrompt> }
  | {
      readonly _tag: "config"
      readonly config: Partial<{
        bpm: number
        scale: string
        density: number
        brightness: number
        guidance: number
        muteBass: boolean
        muteDrums: boolean
        onlyBassAndDrums: boolean
      }>
    }
  | { readonly _tag: "control"; readonly action: "play" | "pause" | "stop" | "reset_context" }

export interface MusicResult extends AudioBlob {
  /** Provider-side song ID for back-reference (ElevenLabs `song_id`, Suno task id, etc.). */
  readonly songId?: string
  /** Generated lyrics if the provider returned them (Lyria, Suno, Mureka). */
  readonly lyrics?: string
  /** Structured section info if returned (start, end, label). */
  readonly sections?: ReadonlyArray<{
    readonly label: string
    readonly startSeconds: number
    readonly endSeconds: number
  }>
  /** Watermark presence (Lyria SynthID, etc.). */
  readonly watermark?: { readonly kind: string }
}

// packages/core/src/music-generator/MusicGenerator.ts

export class MusicGenerator extends Context.Service<
  MusicGenerator,
  {
    readonly generate: (
      req: CommonGenerateMusicRequest,
    ) => Effect.Effect<MusicResult, AiError.AiError>
    readonly streamGeneration: (
      req: CommonStreamGenerateMusicRequest,
    ) => Stream.Stream<AudioChunk, AiError.AiError>
    readonly streamGenerationFrom: (
      input: Stream.Stream<MusicSessionInput, AiError.AiError>,
      opts: { readonly model?: string; readonly initialConfig?: CommonGenerateMusicRequest },
    ) => Stream.Stream<AudioChunk, AiError.AiError>
  }
>()("@betalyra/effect-uai/MusicGenerator") {}

/** Compile-time capability marker for bidirectional sessions. */
export class MusicInteractiveSession extends Context.Service<MusicInteractiveSession, void>()(
  "@betalyra/effect-uai/capability/MusicInteractiveSession",
) {}

export const generate = (
  req: CommonGenerateMusicRequest,
): Effect.Effect<MusicResult, AiError.AiError, MusicGenerator> =>
  Effect.flatMap(MusicGenerator, (s) => s.generate(req))

export const streamGeneration = (
  req: CommonStreamGenerateMusicRequest,
): Stream.Stream<AudioChunk, AiError.AiError, MusicGenerator> =>
  Stream.unwrap(Effect.map(MusicGenerator, (s) => s.streamGeneration(req)))

/** Dual-arity (data-first / data-last) — pipeable with `Stream.pipeTo` etc. Requires `MusicInteractiveSession` in `R`. */
export const streamGenerationFrom: {
  (opts: {
    readonly model?: string
    readonly initialConfig?: CommonGenerateMusicRequest
  }): (
    input: Stream.Stream<MusicSessionInput, AiError.AiError>,
  ) => Stream.Stream<AudioChunk, AiError.AiError, MusicGenerator | MusicInteractiveSession>
  (
    input: Stream.Stream<MusicSessionInput, AiError.AiError>,
    opts: { readonly model?: string; readonly initialConfig?: CommonGenerateMusicRequest },
  ): Stream.Stream<AudioChunk, AiError.AiError, MusicGenerator | MusicInteractiveSession>
} = Function.dual(2, (input, opts) =>
  Stream.unwrap(Effect.map(MusicGenerator, (s) => s.streamGenerationFrom(input, opts))),
)
```

Why this matches the TTS shape exactly:

- `generate` ↔ `synthesize`: sync request/response.
- `streamGeneration` ↔ `streamSynthesis`: sync request, streamed audio output.
- `streamGenerationFrom` ↔ `streamSynthesisFrom`: bidirectional, capability-gated.

A user wiring up a `RealtimeLyria` pipeline can therefore reuse intuition (and code shape) from `streamSynthesisFrom`.

## Capability matrix

| Provider         | `generate`                                                  | `streamGeneration`                         | `streamGenerationFrom`                         |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| Lyria 3 (Gemini) | ok                                                          | emulated (single chunk)                    | **does not provide `MusicInteractiveSession`** |
| Lyria RealTime   | emulated (collect first audio span from a one-shot session) | ok (chunks from session, no further input) | **provides `MusicInteractiveSession`**         |
| ElevenLabs Music | ok                                                          | ok (`/v1/music/stream`)                    | **does not provide `MusicInteractiveSession`** |
| Mureka           | ok (poll)                                                   | emulated (single chunk)                    | **does not provide `MusicInteractiveSession`** |
| MiniMax Music    | ok                                                          | emulated (single chunk)                    | **does not provide `MusicInteractiveSession`** |
| Stable Audio 2.5 | ok                                                          | emulated (single chunk)                    | **does not provide `MusicInteractiveSession`** |
| Suno (3rd-party) | ok (poll)                                                   | ok (provider chunked output)               | **does not provide `MusicInteractiveSession`** |

`emulated` here means the adapter implements the method by calling the sync path and emitting the result as a single `AudioChunk` (for `streamGeneration`) or by collecting a fixed-length session (for `generate`). No runtime `Unsupported` — these are first-class implementations.

The only `Unsupported`-style gap is `streamGenerationFrom` on non-Lyria-RealTime providers, and that surfaces as a **compile-time error** via the missing `MusicInteractiveSession` marker. No runtime branch needed.

---

# Implementation plan

## Phase 0 — Core abstractions (no provider code)

1. `packages/core/src/domain/Music.ts` — `WeightedPrompt`, `CommonGenerateMusicRequest`, `CommonStreamGenerateMusicRequest`, `MusicSessionInput`, `MusicResult`.
2. `packages/core/src/music-generator/MusicGenerator.ts` — `MusicGenerator` service tag, `MusicInteractiveSession` capability marker, dual-arity `generate` / `streamGeneration` / `streamGenerationFrom` helpers.
3. `packages/core/src/index.ts` — add `./Music`, `./MusicGenerator` subpath exports.
4. `packages/core/src/testing/MockMusicGenerator.ts` — scripted layer (`layer({ outputs: AudioBlob[] })` and `layerWithoutInteractive(...)` variants) mirroring `MockTranscriber` / `MockSpeechSynthesizer`.
5. `packages/core/package.json` — add subpath exports for `./Music`, `./MusicGenerator`, `./testing/MockMusicGenerator`.

**Exit criteria**: types compile; mock layer round-trips a scripted `MusicResult`; `expectTypeOf` checks confirm `streamGenerationFrom` against a Layer lacking `MusicInteractiveSession` is a type error.

## Phase 1 — Lyria via Gemini (extend `@effect-uai/google`)

Folded into the existing Gemini package (HTTP / JSON / `generateContent` shape — zero new deps), same pattern as the Gemini TTS work in [stt-tts.md Phase 6a](./stt-tts.md).

### Phase 1a — Lyria 3 sync

1. `models.ts` additions: `LyriaModel` (`lyria-3-clip-preview`, `lyria-3-pro-preview`).
2. `LyriaGenerator.ts`
   - `generate`: `POST /v1beta/models/{model}:generateContent` with `generationConfig.responseModalities: ["AUDIO", "TEXT"]` and `responseFormat.audio.mimeType`. Compose `contents.parts[0].text` from weighted prompts (concatenate as `"prompt1 (weight 1.0). prompt2 (weight 0.3)."` when multiple; provider doesn't expose structured weights here). Append `lyrics` block with `[Verse]` etc. when set. Decode base64 inline_data → `MusicResult` (44.1 kHz stereo, mp3/wav per request, watermark `{ kind: "synthid" }`).
   - `streamGeneration`: emulated — calls `generate`, emits one `AudioChunk`.
   - `streamGenerationFrom`: `Stream.fail(Unsupported)`. Layer omits `MusicInteractiveSession`.
3. Recipe: `recipes/basic-music-generation/` with `run-node.ts` writing `out-lyria.mp3`.

**Exit criteria**: round-trip writes a valid MP3 from `"upbeat indie pop with prominent synths"`; mock tests pass against `MockMusicGenerator`; recipe runs in Node.

### Phase 1b — Lyria RealTime (interactive session)

1. Add `ws` peer dep + custom `WebSocketConstructor` Layer (reuse pattern from OpenAI Realtime Phase 1b in [stt-tts.md](./stt-tts.md)).
2. `LyriaRealtimeGenerator.ts`
   - Opens WS to `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic` inside a `Stream.scoped` so the session closes via Scope finalizer.
   - Sends `setup` (`{ model: "lyria-realtime-001" }` or whichever the public model id is at GA), waits for `setupComplete`.
   - Drains `Stream<MusicSessionInput>`:
     - `prompts` → `client_content: { weightedPrompts: [...] }`
     - `config` → `music_generation_config: { ... }` (and follow with `playbackControl: RESET_CONTEXT` if `bpm` or `scale` changed — per Lyria RealTime docs).
     - `control` → `playbackControl: { play | pause | stop | reset_context }`
   - Pumps server `serverContent.audioChunks[]` → `Stream<AudioChunk>`. `filteredPrompt` and `warning` go to `Effect.log` rather than failing the stream.
3. Layer registers `MusicInteractiveSession` so `streamGenerationFrom` is callable.
4. Recipe: `recipes/lyria-realtime/` with a live demo loop (push a prompt, listen for 10s, push a new prompt, etc.).

**Exit criteria**: a session that switches prompts mid-stream produces audibly distinct sections; ungraceful close releases the WS connection (verified by network inspection).

## Phase 2+ — additional providers

Ordered by user demand and integration cost. Each ships as its own package (or shares an existing one where the provider already has a TTS adapter).

| Phase | Provider         | Package                           | Modes shipped                  | Key complexity                                                      |
| ----- | ---------------- | --------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| 2     | ElevenLabs Music | `@effect-uai/elevenlabs` (extend) | `generate`, `streamGeneration` | Composition-plan plumbing                                           |
| 3     | MiniMax Music    | `@effect-uai/minimax` (extend)    | `generate`                     | Shares auth/HttpClient with TTS adapter                             |
| 4     | Mureka           | `@effect-uai/mureka` (new)        | `generate` (with poll loop)    | Async/poll pattern — first in family                                |
| 5     | Stable Audio 2.5 | `@effect-uai/stability` (new)     | `generate`                     | Stability auth, file output                                         |
| 6     | Suno (3rd-party) | `@effect-uai/suno` (new, opt-in)  | `generate`, `streamGeneration` | Choosing aggregator(s) — `baseUrl` param. Defer until user opts in. |

Udio and an official Suno API are tracked but deferred behind their respective access gates.

## Open questions to resolve before Phase 0

1. **Scale enum vocabulary** — Lyria RealTime accepts a `scale` enum (`C_MAJOR`, `A_MINOR`, …). ElevenLabs / Suno / Mureka use natural-language style in prompts. Do we (a) expose `scale: string` and let providers parse, or (b) ship a `MusicalScale` literal union? Lean (a) for now; promote to literal union once we ship more than one provider that consumes it structurally.
2. **Watermark surfacing** — Lyria SynthID is always present. Should `MusicResult.watermark` be required-`undefined` vs optional, and do we want to add a `verifyWatermark` helper later? Optional for now; defer helper.
3. **Provider-options namespacing** — should `providerOptions` be `Record<string, unknown>` (current sketch) or per-provider typed `providerOptions: { lyria?: { ... }, elevenlabs?: { ... } }`? Lean per-provider typed — same precedent as language-model adapter extensions.

## Out of scope for this plan

- Music continuation / extension from reference audio (`reference?: AudioSource` field reserved for a future minor — non-breaking add).
- Stem-export endpoints (Suno v5+, Udio). When we add these, fits as a separate `MusicGenerator.exportStems(songId)` method or a provider extension.
- DAW-style editing (Udio remix, ElevenLabs composition-plan post-edit).
- Aggregator-routing meta-providers (fal, Replicate, AIMLAPI) — separate package family.
- Browser-only realtime transports (WebRTC). Lyria RealTime is WS-only and runs everywhere our existing WS Layer runs.
