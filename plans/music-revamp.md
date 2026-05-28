# Plan: MusicGenerator revamp (v0.7 candidate)

Companion to:

- [plans/music.md](./music.md) — original design doc (May 2026). Several
  facts in it have drifted; corrections listed in §6 below.
- [plans/capabilities.md](./capabilities.md) on the
  `capabilities-redesign` branch — the three-bucket policy this revamp
  aligns with.
- [plans/elevenlabs-music.md](./elevenlabs-music.md) — sibling plan that
  motivated this revamp (the ElevenLabs adapter exposed every problem
  here).

The current `MusicGenerator` (v0.6) was designed against a single
provider (Google Lyria). Adding ElevenLabs surfaced the question of
what belongs in `CommonGenerateMusicRequest` and what doesn't. Per-
provider research (10 providers, summarised in §3) and the
capabilities-redesign three-bucket policy now agree on the same
answer: **trim Common to what every-or-almost-every provider honors
structurally, push provider-specific structure to typed extras, and
fix the one shape problem the current API has (variants).**

The music surface is the cleanest place to land this pattern first.
One provider in tree, one external user request, no breakage budget
to worry about.

---

## 1. Current design — review

### 1.1 What's right and stays

- One service with three methods (`generate`, `streamGeneration`,
  `streamGenerationFrom`). Mirrors `Transcriber` / `SpeechSynthesizer`.
- `MusicInteractiveSession` service-level marker on the bidi method.
  Right cut; only Lyria RealTime ships it. Per capabilities §7 Phase 7,
  no per-modifier markers planned for music.
- `MusicResult` extends `AudioBlob` with all-optional metadata
  (`songId`, `lyrics`, `sections`, `watermark`). Caller narrows at
  call site, matches §1 "default path is lax."
- Tagged-union `MusicSessionInput` (`prompts | config | control`).
  Right discriminator.
- `outputFormat?: AudioFormat` on the Common request. Bucket 1
  per-adapter `Unsupported` when not encodable. Correct.

### 1.2 Three concrete shape problems

#### 1.2.1 Prompt-mangling antipattern in the Common request

[Music.ts:21-45](../packages/core/src/domain/Music.ts#L21-L45) has
`bpm`, `scale`, `lyrics`, `WeightedPrompt[]` on the Common surface.
Cross-provider research (§3) shows:

| Field | Providers with a structured wire field |
| --- | --- |
| `WeightedPrompt[]` blend | 2 / 10 (Lyria RealTime, Riffusion `/compose`) |
| `bpm` | 1 / 10 (Lyria RealTime; Tencent has it as free-form description prose) |
| `scale` | 1 / 10 (Lyria RealTime enum, 12 keys) |
| `lyrics` (structured field) | 6 / 10 (ElevenLabs, MiniMax, Mureka, Suno, Riffusion, Tencent) |

Today, [LyriaGenerator.buildPrompt:119](../packages/providers/google/src/LyriaGenerator.ts#L119)
silently splices `bpm`, `scale`, `instrumental`, `durationSeconds`,
and `lyrics` into prompt text:

```
"house BPM: 124. Key/scale: C_MAJOR. Target duration: 30s.\n\nLyrics:\n…"
```

That's exactly the "client-side prompt building" antipattern.
Per capabilities §2.2, `bpm` / `scale` / `WeightedPrompt[]` are
bucket-2 (provider has no structural interpretation): the field
should warn-and-drop, not silently get rewritten into the user's
prompt.

#### 1.2.2 Variants — silent data loss

Suno and Mureka **always return 2 tracks per request**. Current
`generate` returns a single `MusicResult`, so adapters either:

- drop the second variant silently, or
- error out, which would break the abstraction.

Neither is correct. The abstraction has to expose variants as a
list. This is the only hard shape break in this revamp.

#### 1.2.3 `MusicSessionInput.config` is wholly Lyria RealTime-shaped

[Music.ts:60-75](../packages/core/src/domain/Music.ts#L60-L75) embeds
`density`, `brightness`, `guidance`, `muteBass`, `muteDrums`,
`onlyBassAndDrums`, `musicGenerationMode`, `topK`, `temperature`,
`seed`, `bpm`, `scale` in Common. Every one of those is Lyria
RealTime-only at the wire (§3 confirms). When a second bidi provider
lands (Suno is partner-only, ByteDance Seedusic is consumer-app only,
but it will happen), forcing it to either honor or silently ignore
those fields repeats the same antipattern.

Same story for `MusicSessionInput.control` actions
`play | pause | stop | reset_context` — that's Lyria RealTime's
`playback_control` vocabulary verbatim.

### 1.3 Missing pieces

- **`seed`** on Common. Honored structurally by Lyria 2 Vertex, Lyria
  RealTime, ElevenLabs (plan mode only), Stable Audio, MusicGen.
  Bucket 3 tuning hint per §2 — silent where not honored.
- **`reference?: AudioSource`** on Common, or a dedicated `extend`
  method + capability marker. Research (§3) shows 6 / 10 providers
  ship some form of continuation / cover / melody-reference natively.
  No longer niche.
- **`provider?: string`** on `MusicResult` for back-reference in
  multi-provider pipelines.
- **`fallback`** combinator on `MusicGenerator` (lands when the
  generic combinator does, per capabilities Phase 2).

---

## 2. Proposed shape

Code is illustrative, not final. Names and exact field placement up
for refinement during the actual PR.

### 2.1 Trimmed `CommonGenerateMusicRequest`

```ts
export type CommonGenerateMusicRequest = {
  readonly model: string
  /** Single prompt string. Weighted blends are provider-typed extras.
   *  Music providers are one-shot text-to-audio, not conversational —
   *  no `messages[]` shape applies (zero of the 10 surveyed providers
   *  expose one). */
  readonly prompt: string
  /** Structured lyrics when the provider supports them. Lyria 3 embeds
   *  in the prompt at adapter level with a `dropUnsupported` warning;
   *  callers who want guaranteed structured lyrics provide a real
   *  lyrics-aware provider. */
  readonly lyrics?: string
  /** Hint vs hard limit; provider-defined. */
  readonly duration?: Duration.Duration
  /** Universally interpretable, bucket-3 tuning hint. */
  readonly seed?: number
  /** Bucket 1; per-adapter `Unsupported` on un-encodable formats. */
  readonly outputFormat?: AudioFormat
}
```

Removed from Common (now provider-typed extras):

| Field | Reason | Where it lives now |
| --- | --- | --- |
| `prompts: string \| WeightedPrompt[]` | Multi-shape unhelpful when 8 / 10 only take a string | `LyriaRealtimeGenerator.streamGenerationFrom` input |
| `bpm` | Structured on 1 / 10 | `LyriaRealtimeMusicConfig.bpm` |
| `scale` | Structured on 1 / 10 (enum) | `LyriaRealtimeMusicConfig.scale` |
| `instrumental` | Split 4 ways (see below), silent lie on "always instrumental" providers | provider-typed extras per adapter |

**Why `instrumental` moves off Common.** Cross-provider behavior splits
four ways:

- **Structured wire field** (4): ElevenLabs `force_instrumental`,
  MiniMax `is_instrumental`, Suno `instrumental`, Tencent (via
  section tags).
- **Always instrumental, no toggle** (3): Lyria RealTime, Stable
  Audio, MusicGen. Setting `instrumental: false` here would silently
  lie to the caller.
- **Prompt-only embed** (2): Lyria 3, Riffusion.
- **Separate endpoint** (1): Mureka has `/v1/instrumental/generate`
  as a distinct endpoint.

That's exactly the bucket-2 silent-drop antipattern §2.2 of the
capabilities plan forbids. Provider-typed extras per adapter, with
the always-instrumental providers having no field at all (you can't
ask for vocals you can't get).

Note the rename `prompts → prompt`. The plural was a relic of the
weighted-array shape. Single string makes the rename mechanical (it
is the most-edited field across all providers' tests, but the diff is
trivial).

`durationSeconds` becomes `duration: Duration.Duration` for
consistency with the rest of the Effect ecosystem (and with
[AudioBlob](#22-audioblob-also-uses-duration)). Wire encoding to
seconds / ms happens per provider at the adapter boundary.

### 2.2 `AudioBlob` also uses `Duration`

Change [Audio.ts:84-88](../packages/core/src/domain/Audio.ts#L84-L88):

```ts
export type AudioBlob = {
  readonly format: AudioFormat
  readonly bytes: Uint8Array
  readonly duration?: Duration.Duration   // was: durationSeconds?: number
}
```

Same rename applies anywhere else in the tree that currently carries
raw `durationSeconds: number` (Transcript, TTS surfaces). Out of scope
for this plan but worth flagging in the v0.7 changeset.

### 2.3 `MusicResult` composes `AudioBlob`, doesn't extend it

Current shape uses intersection (`MusicResult = AudioBlob & { ... }`).
That's the OO "extends" pattern. Replace with composition:

```ts
export type Watermark = "synthid" | "c2pa" | (string & {})

export type MusicSection = {
  readonly label: string
  readonly startSeconds: number
  readonly endSeconds: number
}

export type MusicResult = {
  readonly audio: AudioBlob
  readonly provider?: string
  readonly songId?: string
  readonly lyrics?: string
  readonly sections?: ReadonlyArray<MusicSection>
  readonly watermark?: Watermark
}

export type GenerateResult = {
  /** First variant; convenience for the 8 / 10 providers that only
   *  return one. Equal to `variants[0]`. */
  readonly primary: MusicResult
  /** Every variant the provider returned. Length ≥ 1. Suno and
   *  Mureka return 2; everyone else returns 1. */
  readonly variants: ReadonlyArray<MusicResult>
}
```

Two FP wins:

- `audio` is its own value — pass to `writeFile`, hash it, transcode
  it, without spreading.
- Adding fields to `AudioBlob` can never conflict with fields on
  `MusicResult`. (Today they share the namespace.)

`Watermark` is a bare string-literal union — no provider exposes
additional metadata about the watermark (SynthID is present-or-absent,
C2PA presence implies the request's MP3 format), so wrapping it in a
record would just add nesting for nothing. `MusicSection` does need a
record (label + start + end), so it gets one.

`generate` now returns `GenerateResult`, not `MusicResult` directly.
`primary` covers the common case ergonomically; `variants` covers
Suno / Mureka without silent drops.

### 2.4 `MusicGenerator` service surface

```ts
export type MusicGeneratorService = {
  readonly generate: (
    request: CommonGenerateMusicRequest,
  ) => Effect.Effect<GenerateResult, AiError.AiError>

  readonly streamGeneration: (
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>

  readonly streamGenerationFrom: <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<MusicStreamEvent, AiError.AiError | E, R>
}
```

The notable change: `streamGenerationFrom` now yields
`MusicStreamEvent`, not raw `AudioChunk`. Lyria RealTime emits
`filteredPrompt` and `warning` server messages today that just get
logged; they belong in-band alongside audio chunks, same way
`TurnEvent` works in the LLM surface.

**Extend / continuation is deliberately not added in v0.7.** Strict
"make this song longer" semantics are native on only 4 / 10
providers (Suno, Mureka, MusicGen, Stable Audio continuation), and
those 4 disagree on every input axis:

- Suno: `audioId` (returned from earlier call) + `continueAt: seconds`. Returns 2 tracks.
- Mureka: separate endpoint, takes a song ID.
- MusicGen: `input_audio` (bytes/URL) + `continuation: true` + `continuation_start`/`continuation_end`.
- Stable Audio: `init_audio` URL + `init_noise_level` — really inpainting, not extension.

The "adjacent" 3 (ElevenLabs inpainting, MiniMax cover, Tencent
style-ref) aren't extension at all — they're different operations.

Per capabilities §4, a marker (and the method it gates) needs (a) a
real consumer with a documented use case and (b) at least one
provider that supports + one that doesn't. We have (b), but not (a).
And four providers with three semantic models is a recipe for an
abstraction that fits none of them.

v0.7 just reserves the design space — no field name conflict on
`reference`, `extend`, `continueFrom`, `init_audio`. When a second
user asks, add `extend` + `MusicExtension` marker in v0.8/0.9 once
we have ≥ 2 adapters in tree to disambiguate the semantics.

```ts
export type MusicStreamEvent =
  | { readonly _tag: "audio"; readonly chunk: AudioChunk }
  | { readonly _tag: "warning"; readonly message: string }
  | { readonly _tag: "filteredPrompt"; readonly prompt: string; readonly reason: string }
```

### 2.5 `MusicSessionInput` parameterised

```ts
/** Lyria-RealTime-shaped session input. Other interactive providers
 *  re-type the union with their own config / control variants. */
export type LyriaRealtimeSessionInput =
  | { readonly _tag: "prompts"; readonly prompts: ReadonlyArray<WeightedPrompt> }
  | { readonly _tag: "config"; readonly config: LyriaRealtimeMusicConfig }
  | { readonly _tag: "control"; readonly action: LyriaRealtimeControl }

/** Generic carrier used by the cross-provider `MusicGenerator`
 *  service. Lyria's typed service narrows to the Lyria union. */
export type MusicSessionInput =
  | { readonly _tag: "prompts"; readonly prompts: ReadonlyArray<WeightedPrompt> }
  | { readonly _tag: "config"; readonly config: unknown }
  | { readonly _tag: "control"; readonly action: string }
```

Provider-typed services (`LyriaRealtimeGenerator.streamGenerationFrom`)
take the narrowed input. The generic `MusicGenerator.streamGenerationFrom`
takes the wide one. Callers who want type-safe config knobs use the
provider-typed service; callers who want cross-provider portability
use the generic one and live with `unknown` config.

### 2.6 Capability markers

| Marker | Status | Justification |
| --- | --- | --- |
| `MusicInteractiveSession` | Existing | Service-level; gates `streamGenerationFrom`. Per capabilities §7 Tier 1. |

No per-modifier markers, no new service-level markers. Per
capabilities §7 Phase 7:

> Phase 7 — Music generation. `MusicInteractiveSession` already in
> tree; no per-modifier markers planned. Confirmed by the upcoming
> ElevenLabs music provider — Eleven Music has no bidirectional
> session, ships no `MusicInteractiveSession` marker, and C2PA opt-in
> does not qualify as a marker under §4 (bucket 2 at most).

### 2.7 Per-adapter cleanup

LyriaGenerator [LyriaGenerator.ts:119-141](../packages/providers/google/src/LyriaGenerator.ts#L119-L141):
the `buildPrompt` splicer goes. Replace with explicit warnings via
`dropUnsupported` once it lands (capabilities Phase 0); for now,
`Effect.logWarning` with the same structured shape the capabilities
plan defines.

Specifically:

- `bpm`, `scale`, `instrumental` are removed from Common, so the
  adapter no longer sees them. Lyria 3 callers who want tempo / key /
  vocals control put it in their prompt themselves, or move to the
  Lyria-typed request when extras are exposed (see §2.8).
- `lyrics`: Lyria 3 still embeds in prompt at adapter level. Bucket
  2: warn that we're embedding rather than passing structured. Lyria
  3 wire has no lyrics field, so embedding is the best you get.
- `WeightedPrompt[]` is gone from Common, so adapter no longer needs
  to handle the array case.

### 2.8 Provider-typed request extras

Each adapter that needs more than `CommonGenerateMusicRequest`
exposes a provider-typed request, narrowed in the obvious places.
Examples:

```ts
// google/LyriaGenerator.ts
export type LyriaGenerateRequest = Omit<CommonGenerateMusicRequest, "model"> & {
  readonly model: LyriaModel
  /** Lyria-3 has no wire field; prompt-embedded. */
  readonly instrumental?: boolean
}

// elevenlabs/ElevenLabsMusicGenerator.ts
export type ElevenLabsMusicGenerateRequest = Omit<CommonGenerateMusicRequest, "model"> & {
  readonly model?: ElevenLabsMusicModel
  readonly forceInstrumental?: boolean
  readonly compositionPlan?: ElevenLabsCompositionPlan
  readonly signWithC2pa?: boolean
  readonly respectSectionsDurations?: boolean
}

// (future) minimax/MiniMaxMusicGenerator.ts
export type MiniMaxMusicGenerateRequest = Omit<CommonGenerateMusicRequest, "model"> & {
  readonly model: MiniMaxMusicModel
  readonly isInstrumental?: boolean
  readonly lyricsOptimizer?: boolean
}
```

Providers that natively support always-instrumental output (Lyria RT,
Stable Audio, MusicGen) simply don't expose an instrumental field —
you can't ask for vocals you can't get.

### 2.7 Wire-format conversions per adapter

| Common field | Lyria 3 (Gemini) | ElevenLabs | MiniMax | Mureka | Stable Audio | Suno | MusicGen |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `prompt` | `contents.parts[0].text` | `prompt` | `prompt` | `prompt` (`desc`) | `prompt` | `prompt` | `prompt` |
| `lyrics` | embed in prompt + warn | embed in prompt (or use `compositionPlan.lines` via typed extra) + warn | `lyrics` field | `lyrics` field (required) | n/a — warn-and-drop | `prompt` field in custom mode | n/a — warn-and-drop |
| `durationSeconds` | n/a — warn (clip fixed 30 s; pro derived) | `music_length_ms = s * 1000` | n/a — derived from lyrics | `duration` (max 240) | `seconds_total = s` (max 180; 360 on 3.0) | model-determined — warn | `duration = s` |
| `seed` | n/a — warn (Lyria 3 Gemini lacks seed) | only when `compositionPlan` set | n/a — warn | n/a — warn | `seed` | n/a — warn | `seed` |
| `instrumental` | embed `"no vocals."` + warn | `force_instrumental` | `is_instrumental` | use `/instrumental/generate` endpoint | n/a (always inst) | `instrumental` | n/a (always inst) |
| `outputFormat` | `mimeType` (mp3 or wav-pro-only) | `?output_format=` slug | `audio_setting.{sample_rate, bitrate, format}` | per `choices[]` format | `output_format` (wav or mp3) | fixed mp3 — warn | `output_format` (wav or mp3) |

All warn-and-drop cells become `Effect.logWarning` today, migrating
to `dropUnsupported` when capabilities Phase 0 ships.

---

## 3. Cross-provider matrix (research summary)

Source: two parallel research agents, May 2026. Full results in
research transcript. Cells: **S** structured wire field, **P**
prompt-embedded, **—** unsupported, **?** unknown.

| Capability | Lyria 3 | Lyria RT | ElevenLabs | MiniMax | Stable Audio | Mureka | Suno | MusicGen | Riffusion | Tencent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Single text prompt | S | — | S | S | S | S | S | S | S | S |
| Weighted blend | — | S | — | — | — | — | — | — | S | — |
| Structured lyrics | P | — | S | S | — | S | S | — | S | S |
| BPM control | P | S (60-200) | P | P | P | P | P | P | P | P (in description) |
| Scale / key | P | S (12 enum) | P | P | P | P | P | P | P | P |
| Instrumental flag | P | (forced) | S | S | (forced) | (endpoint) | S | (forced) | P | S |
| Duration | S (fixed 30 s clip) | session | S (3-600 s) | derived | S (1-180 s, 360 on v3) | S (max 240 s) | model-determined | S | ? | derived |
| Seed | — | S | S (plan only) | — | S | — | — | S | ? | ? |
| Reference audio | — | — | S (inpainting; enterprise) | S (covers) | S (init_audio + mask) | S (ref_id / melody_id) | S (extend / cover) | S (input_audio + continuation) | ? | S (10 s prompt_audio) |
| Output format choice | partial (mp3 vs wav-pro) | fixed PCM 48k stereo | S (~20 slugs) | S | S (wav / mp3) | S | fixed mp3 CDN | S (wav / mp3) | fixed m4a | ? |
| Variants per call | 1 | stream | 1 | 1 | 1 | **2** | **2** | 1 | 1 | 1 |
| Composition plan | — | — | S | — | — | — | — | — | S (compose endpoint) | S (lyric labels) |
| Streaming output | — | S (WS bidi) | S (SSE) | S (`stream:true` hex) | — | — | S (separate URL) | — | — | — |
| Bidi / interactive | — | S | — | — | — | — | — | — | — | — |
| Watermark | S (SynthID forced) | S (SynthID forced) | S (C2PA opt-in) | — | — | — | — | — | — | — |
| Async + poll | — | — | — | (status field) | S (Stability platform) | S (`/song/query/{id}`) | S (`record-info`) | S (Replicate predictions) | ? | S (WaveSpeed task) |

**Patterns confirmed:**

1. Single text prompt is universal. ✓
2. Weighted blend is Lyria RealTime + Riffusion compose only. Move
   to provider extras. ✓
3. Structured BPM / scale are Lyria RealTime only. Provider extras. ✓
4. Lyrics: 6 / 10 structured, plus 2 more prompt-embedded.
   Common-field, adapter routes. ✓
5. Variants: hard 2 for Suno + Mureka, hard 1 elsewhere. Change
   shape. ✓
6. Continuation / reference: 6 / 10 supported, semantics vary.
   Marker + `extend` method. ✓
7. Streaming: 4 regimes (none / SSE / custom JSON / WS bidi). Hide
   in adapter; expose `Stream<AudioChunk>` consistently. ✓ (already
   done)
8. Async/poll: 3 regimes (sync / poll / webhook). Hide in adapter.
   ✓ (already done)
9. Watermark: 3 regimes (forced / opt-in / absent). `MusicResult.watermark?`
   handles all three. ✓ (already done)

---

## 4. Migration

### 4.1 Breaking changes vs v0.6

| Change | Mechanical? |
| --- | --- |
| `prompts → prompt`, drop `WeightedPrompt[]` array form | yes, one rename |
| `bpm`, `scale`, `instrumental` removed from `CommonGenerateMusicRequest` | yes, deletions; `instrumental` reappears on Lyria-typed and ElevenLabs-typed requests |
| `durationSeconds: number → duration: Duration.Duration` on request + `AudioBlob` | yes, mechanical (`Duration.seconds(n)`) |
| `MusicResult = AudioBlob & { … }` → `MusicResult = { audio: AudioBlob, … }` | callers swap `result.bytes` → `result.audio.bytes` |
| `generate` returns `GenerateResult` not `MusicResult` | callers add `.primary` |
| `streamGenerationFrom` yields `MusicStreamEvent` not `AudioChunk` | callers `filterMap` for `_tag: "audio"` or add `Loop.value` handling |
| `MusicSessionInput.config` is `unknown` on the generic surface; narrowed on `LyriaRealtimeGenerator` | code using config knobs switches to the typed Lyria service |
| `MusicSessionInput.control` is `string` on the generic surface; enum on `LyriaRealtimeGenerator` | same |
| `Watermark` extracted as named type (string-literal union) | import name only |

Lyria is the only provider in tree today. The `recipes/basic-music-generation`
recipe needs short updates (`.primary.audio.bytes`, drop `bpm` /
`scale` / `lyrics` field setters that were silently spliced).

### 4.2 Migration doc

`docs/migrations/v0-7.md` with the before/after table for every
breaking change. Same shape as
[docs/migrations/v0-6.md](../docs/migrations/v0-6.md).

### 4.3 Sequencing

1. **Phase 0** — domain types (`Music.ts`, `Audio.ts`,
   `MusicGenerator.ts`, `MockMusicGenerator.ts`). Rename + trim,
   add `GenerateResult` / `MusicStreamEvent`, swap to `Duration`,
   compose `AudioBlob` instead of intersect.
2. **Phase 1** — Lyria adapter cleanup. Remove `buildPrompt` splicing
   for removed fields. Add `LyriaGenerateRequest.instrumental` typed
   extra. Replace silent splicing with `Effect.logWarning` for
   remaining bucket-2 case (`lyrics` on Lyria 3). Tests refreshed.
3. **Phase 2** — ElevenLabs adapter (paused awaiting this revamp;
   resumes after Phase 1).
4. **Phase 3** — recipe `basic-music-generation` updated to support
   two providers (per the original ElevenLabs ask).
5. **Phase 4** — migration doc + v0.7 changeset.

---

## 5. Open questions

Resolved during review:

- ~~`MusicSessionInput.config` typing~~ — drop the phantom-parameter
  idea, default to `unknown` on the generic surface. Callers wanting
  config typing use the provider-typed service.
- ~~Composition plans (ElevenLabs, Tencent)~~ — provider-typed extras.
- ~~`watermark.kind` shape~~ — bare string-literal union, no nested
  record.
- ~~`extend` argument shape~~ — moot; `extend` is deferred to a future
  minor.
- ~~Riffusion `prompt_1/2/3`~~ — provider-typed extra (per-window
  styling, not weighted blend).

Still open:

1. **Should `prompt` be required on `generate`?** Required for v0.7.
   When `extend` lands (later), it'll take an optional prompt for
   continuation steering.

---

## 6. Corrections to plans/music.md

Apply during Phase 0.

1. Lyria RealTime model ID: `models/lyria-realtime-exp`, not
   `lyria-realtime-001`.
2. **Add Lyria 2 on Vertex AI** as a third Lyria surface entry. GA
   (not preview), `lyria-002`, OAuth not API-key, has structured
   `negative_prompt` + `seed`. Different transport — separate adapter
   when we ship it.
3. ElevenLabs Music v2 launched 2026-05-26. API `model_id` not yet
   plumbed; default stays `music_v1`. Don't hardcode v2.
4. ElevenLabs detailed endpoint path is `/v1/music/detailed`, not
   `/compose-detailed`.
5. ElevenLabs `song_id` returned in **response headers** for compose,
   in the multipart JSON metadata for `/detailed`.
6. ElevenLabs upload endpoint (`POST /v1/music/upload`) added
   2026-03-02; powers inpainting workflows.
7. Mureka model IDs are `V8` / `O2` / `V7.6` / `V7.5` / `auto`. The
   `music-2.5` / `music-2.6` names belong to MiniMax.
8. Mureka ships native `POST /v1/song/extend` — pull continuation
   forward in the roadmap.
9. MiniMax field name is `is_instrumental` (not `instrumental`),
   auth is Bearer JWT (not custom header), current GA is `music-2.6`.
   Drop `music-2.5`.
10. Stable Audio 3.0 released 2026-05-20. Three sizes: Small/Medium
    open-weights, Large API-only. Max duration extended to 6 min on
    v3 (up from 3 min on 2.5).
11. Suno v5.5 (2026-03-26) added Custom Models / Voices / My Taste,
    not stem export (that was v5).
12. ElevenLabs Merlin/Kobalt licensing claim isn't in current docs;
    soften wording.
13. Tencent SongGeneration (Mar 2026) — open-weights model with
    commercial API via WaveSpeed. Worth adding as a known entrant.
14. Riffusion has an official private-beta API + multiple third-party
    wrappers. The compose endpoint uses `prompt_1/2/3` with strength
    / start / end — closest thing to weighted prompts besides Lyria
    RealTime.
15. Udio remains partner-only as of May 2026. Drop the "v4 Enterprise
    API" reference unless we get a real wire-shape doc.

---

## 7. Effort

| Phase | Surface | Effort |
| --- | --- | --- |
| 0 — Domain types + mock | ~150 LOC across `Music.ts`, `Audio.ts` (Duration migration), `MusicGenerator.ts`, `MockMusicGenerator.ts` | half-day |
| 1 — Lyria adapter cleanup | ~80 LOC in `LyriaGenerator.ts` + tests; `LyriaGenerateRequest` typed-extras for `instrumental` | half-day |
| 2 — ElevenLabs adapter | per [plans/elevenlabs-music.md](./elevenlabs-music.md), simplified by trimmed Common; `forceInstrumental` on typed request | ~1 day |
| 3 — Recipe refactor | `--provider=` flag, dual outputs | 1 hour |
| 4 — Migration doc + changeset | mechanical | 2 hours |

Total: ~2.5 days for a coherent v0.7 release. (`extend` and the
Lyria-RealTime typed surface deferred.)
