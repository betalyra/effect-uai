# Capability Handling — Inventory & Guidelines

Across the providers we expose, every AI vendor has gaps: OpenAI has no
incremental-text-in TTS, Gemini has no diarization, ElevenLabs only
accepts IPA on some models, OpenAI Embeddings reject image parts, and
so on. This document inventories the mechanisms we use, names the
trade-offs of each, and gives a decision matrix for choosing between
them.

**Two levels of capability live in this design:**

- **Service-level** — does this provider implement the whole feature?
  ("Does this Layer do TTS at all?", "Does this STT Layer do realtime
  streaming?"). Already handled by compile-time markers like
  `TtsIncrementalText`, `SttStreaming`, `MultiSpeakerTts`. Keep using
  them; nothing changes here.
- **Per-modifier** — within a service, does this provider honor this
  request flag? ("Does this STT Layer diarize?", "Does this LLM Layer
  emit cache token counts?"). New material, layered onto the existing
  pattern. See §4.2 and the
  [capabilities spike](../experiments/capabilities-spike/index.ts) for
  the reference implementation.

This is a design analysis. No production code is changed by reading
it. §9 lists concrete action items.

---

## 1. The patterns we use today

### 1.1 Compile-time phantom capability markers

A capability is encoded as a `Context.Service<X, void>` tag that the
top-level helper requires in its `R` channel. Provider Layers that
support the capability ship `Layer.succeed(Marker, undefined)`;
providers that don't simply omit the line. Calling the helper while
only a non-supporting Layer is in scope is a compile-time error at
`Effect.provide` (or, more practically, at `Effect.runPromise`, which
requires `R = never`).

**Service-level markers in `packages/core/src` today:**

- `SttStreaming` — [Transcriber.ts:80](../packages/core/src/transcriber/Transcriber.ts#L80)
- `TtsIncrementalText` — [SpeechSynthesizer.ts:162](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L162)
- `MultiSpeakerTts` — [SpeechSynthesizer.ts:180](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L180)
- `MusicInteractiveSession` — [MusicGenerator.ts:68](../packages/core/src/music-generator/MusicGenerator.ts#L68)
- The `Sandbox*` family — [Sandbox.ts:419+](../packages/core/src/sandbox/Sandbox.ts#L419)

Registration is always unconditional per Layer — the conditional axis
is which Layer the caller imports (e.g. `InworldSynthesizer` vs.
`InworldRealtimeSynthesizer`). No marker is gated by a runtime config.

**Per-modifier markers (proposed, demonstrated in the spike):** same
shape, finer granularity. Examples we'd introduce:

- `DiarizationGuarantee` on Transcriber
- `WordTimestampsGuarantee` on Transcriber
- `CacheControlGuarantee` on LLM
- `StructuredOutputGuarantee` on LLM
- `SeedGuarantee` on ImageGen

A `require<Capability>` combinator injects the marker into `R`:

```ts
export const requireDiarization = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | DiarizationGuarantee> =>
  Effect.flatMap(DiarizationGuarantee.asEffect(), () => eff)
```

A `fallback` combinator intersects markers across tiers — a marker
survives only if every tier ships it. See spike §`fallback` for the
type-level machinery (uses `<const Layers extends ...>` + `infer _E,
infer _RIn` to avoid TS contravariance traps).

### 1.2 Runtime `AiError.Unsupported`

A tagged error in [AiError.ts:97](../packages/core/src/domain/AiError.ts#L97). The
docstring policy: **request-data-dependent gaps → runtime
`Unsupported`; blanket provider-level gaps → compile-time markers.**
Three subcategories in the wild:

**(a) "blanket method-not-supported on this Layer"** — stub bodies in
the sync Layer for a method that only exists on the realtime Layer.
Duplicates of marker information at runtime, exist because the
service interface has all five methods. Examples:

- [InworldSynthesizer.ts:210](../packages/providers/inworld/src/InworldSynthesizer.ts#L210), [:223](../packages/providers/inworld/src/InworldSynthesizer.ts#L223), [:234](../packages/providers/inworld/src/InworldSynthesizer.ts#L234)
- [GeminiSynthesizer.ts:166](../packages/providers/google/src/GeminiSynthesizer.ts#L166), [:176](../packages/providers/google/src/GeminiSynthesizer.ts#L176), [:186](../packages/providers/google/src/GeminiSynthesizer.ts#L186)
- [OpenAISynthesizer.ts:169](../packages/providers/openai/src/OpenAISynthesizer.ts#L169), [:181](../packages/providers/openai/src/OpenAISynthesizer.ts#L181), [:191](../packages/providers/openai/src/OpenAISynthesizer.ts#L191)
- [LyriaGenerator.ts:339](../packages/providers/google/src/LyriaGenerator.ts#L339)

**(b) "request-data-dependent gap"** — the provider supports the
method in general but not for these inputs. The docstring's "intended"
use of `Unsupported`. Examples:

- Output-format codec rejection: [inworld/codec.ts:25](../packages/providers/inworld/src/codec.ts#L25), [openai/codec.ts:107](../packages/providers/openai/src/codec.ts#L107), [elevenlabs/codec.ts:65](../packages/providers/elevenlabs/src/codec.ts#L65), [GeminiSynthesizer.ts:67](../packages/providers/google/src/GeminiSynthesizer.ts#L67)
- Realtime input-format rejection: [inworld/realtimeStt.ts:39](../packages/providers/inworld/src/realtimeStt.ts#L39), [openai/realtimeStt.ts:33](../packages/providers/openai/src/realtimeStt.ts#L33), [elevenlabs/realtimeStt.ts:23](../packages/providers/elevenlabs/src/realtimeStt.ts#L23)
- Model × format: [LyriaGenerator.ts:257](../packages/providers/google/src/LyriaGenerator.ts#L257) (clip models reject wav)
- Model × feature: [OpenAITranscriber.ts:85](../packages/providers/openai/src/OpenAITranscriber.ts#L85) (word-timestamps only on whisper-1)

**(c) "request-flag-dependent blanket"** — field is on the request
type but rejected unconditionally when set. The worst case: blanket at
the provider level, but the field is still in the type, so the caller
has no compile-time signal.

- [GeminiTranscriber.ts:48-65](../packages/providers/google/src/GeminiTranscriber.ts#L48-L65) — `wordTimestamps`, `diarization`
- [OpenAITranscriber.ts:94](../packages/providers/openai/src/OpenAITranscriber.ts#L94) — `diarization`

Under the new per-modifier framework, (c) becomes a per-modifier
marker case: narrow the field out of the typed request (row B), AND
declare absence of the marker on the generic Layer (the consumer's
`requireDiarization` will fail to compile against this Layer).

### 1.3 Silent drops

A field is accepted on the request type but discarded without a log
when the provider can't honor it. Audio/text/etc. still renders.

- **Pronunciations** by encoding:
  - [InworldSynthesizer.ts:78-95](../packages/providers/inworld/src/InworldSynthesizer.ts#L78-L95) — IPA kept, others silently dropped
  - [ElevenLabsSynthesizer.ts:79-113](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79-L113) — whole-array drop on unsupported model + per-item drop for x-sampa, no log
- **Embedding `task`** ignored on some models:
  - [GeminiEmbedding.ts:29-30](../packages/providers/google/src/GeminiEmbedding.ts#L29) — honored by `gemini-embedding-001`, ignored by `gemini-embedding-2`
  - [OpenAIEmbedding.ts:27-31](../packages/providers/responses/src/OpenAIEmbedding.ts#L27) — accepts and silently ignores `task` on the generic surface
- **`instructions`** on OpenAI TTS: [OpenAISynthesizer.ts:30-31](../packages/providers/openai/src/OpenAISynthesizer.ts#L30) — honored only by `gpt-4o-mini-tts`
- **Sample rate on OpenAI**: [openai/codec.ts:93](../packages/providers/openai/src/codec.ts#L93) — `sampleRate` ignored; provider reports realized format on the output

No provider currently `logWarning`s for a dropped capability field —
silent drops are truly silent.

### 1.4 Type-level request narrowing (`Omit` and re-typing)

Every provider request is `Omit<CommonX, ...> & { ...narrowed }`. The
common pattern is to narrow `model` to a literal union, and for TTS
also `voiceId`. Embedding providers further narrow or remove `task`
and `encoding`:

- [JinaEmbedding.ts:68](../packages/providers/jina/src/JinaEmbedding.ts#L68) — narrows `model`, `task`, `encoding`
- [OpenAIEmbedding.ts:32](../packages/providers/responses/src/OpenAIEmbedding.ts#L32) — narrows `model`; removes `task` and `encoding` entirely
- [GeminiEmbedding.ts:42](../packages/providers/google/src/GeminiEmbedding.ts#L42) — narrows `model`, widens `task` to an 8-value enum

The same field (`task`) is handled three different ways across three
packages. The new framework keeps narrowing as the right tool for
identity-typed fields, and adds the per-modifier marker for the
configuration-gate case.

### 1.5 `InvalidRequest` used for capability gaps

A grey zone: when a wire-API shape mismatch is reported, providers
sometimes use `InvalidRequest` for what is really a capability gap.

- URL `AudioSource` rejected on inline-only providers: [inworld](../packages/providers/inworld/src/InworldTranscriber.ts#L59), [google](../packages/providers/google/src/geminiSpeechCodec.ts#L11), [elevenlabs](../packages/providers/elevenlabs/src/codec.ts#L86), [openai](../packages/providers/openai/src/codec.ts#L16)
- Image part rejected on text-only embedding: [OpenAIEmbedding.ts:68](../packages/providers/responses/src/OpenAIEmbedding.ts#L68)
- Multi-part embedding input rejected: [JinaEmbedding.ts:138](../packages/providers/jina/src/JinaEmbedding.ts#L138)

The URL-audio cases stay on `InvalidRequest` (genuine wire-shape
mismatch). The embedding cases should move to `Unsupported`
(see §9.2).

### 1.6 (Half-pattern) Disjoint / tagged-union requests

**Not yet used in tree.** Proposed for sub-APIs that diverge in more
than one field (Google Cloud TTS `chirp-3-hd` vs `gemini-tts`, Lyria
`clip` vs `pro`). The Lyria split currently uses a runtime predicate
([isClipModel](../packages/providers/google/src/LyriaGenerator.ts#L93)),
not a tagged union.

---

## 2. Trade-offs of each pattern

### Phantom capability marker (§1.1)

**Pros**

- Type error at provide-time / run-time — caller sees the gap before
  the wire call.
- Zero runtime cost (`void` service).
- Composable: one marker per capability, providers opt in piecemeal.
- Survives `fallback`: a marker stays only if every tier ships it.

**Cons**

- Adds a tag to import; verbose for callers who already provide the
  parent service.
- Doesn't help in **dynamic** provider selection (e.g. a
  `selectByModel` function returning a `SpeechSynthesizerService` —
  the marker is gone from the value).
- Only works for **blanket** gaps that are pinned to which Layer is in
  scope. Per-model variance within one Layer needs separate per-model
  Layers (e.g. `OpenAIWhisper1Layer` vs `OpenAIGpt4oTranscribeLayer`).
- Discovery: cryptic R-channel error if the caller doesn't know the
  marker exists. Less self-documenting than autocompletion.

### Runtime `Unsupported` (§1.2)

**Pros**

- Granular: carries `capability`, `reason`, and request context.
- Handles request-data dependence cleanly (model × feature × format).

**Cons**

- Caller must remember to handle it.
- For **blanket method-not-supported** (§1.2(a)), duplicates marker
  information — strictly worse than the marker alone (the marker
  catches it at compile time).
- §1.2(c) ("request-flag-dependent blanket") is the worst form: field
  is on the type, runtime rejects unconditionally. The new
  per-modifier marker pattern eliminates this category.

### Silent drop (§1.3)

**Pros**

- Maximizes "it just works" for cross-provider code.
- Right answer when the field is _advisory_ (e.g. STT `prompt`
  biasing).

**Cons**

- Invisible to the caller; degraded output, hard to diagnose.
- Inconsistent across providers — caller can't predict which fields
  silently fail.
- No telemetry hook.

### Type-level narrowing (`Omit` / re-typing) (§1.4)

**Pros**

- Best DX for identity-typed fields (model, voice ID): autocompletion
  just works.
- Removes invalid choices entirely; no runtime check needed.

**Cons**

- Forces per-provider request types; cross-provider code needs adapter
  layers.
- Doesn't compose with the _generic_ helper.

### `InvalidRequest` for capability gaps (§1.5)

**Pros**

- Conceptually close enough that callers usually do the right thing.

**Cons**

- Conflates "malformed request" with "feature unsupported". Different
  remediation.

---

## 3. Patterns we haven't fully explored

### 3.1 Service-shape variance via per-Layer typing

Today's `SpeechSynthesizerService` has all five methods, so every
Layer implements all five (real or stub). Alternative: factor into
`SpeechSynthesizerSync` + `SpeechSynthesizerRealtime` services. Pro:
methods that don't exist don't appear. Con: callers need multiple
services; `synthesizeDialogue` doesn't cleanly split. Marker pattern
hits the same goal with less ceremony.

### 3.2 Tagged-union request types

For genuinely-divergent sub-APIs (chirp-3-hd vs gemini-tts, Lyria clip
vs pro). Recommended only when variants differ in **more than one
field**.

### 3.3 Schema-based validation at the boundary

Encode capability gates as `Schema.filter` refinements. Heavier than
the problem warrants for most adapter guards.

### 3.4 Smart constructors

`Chirp3HdRequest.make(input)` returns `Effect<..., Unsupported>`.
Awkward when requests are assembled outside Effect.

### 3.5 Warn-and-drop with structured observability

Today's silent drops + `Effect.logWarning` + a typed
`CapabilityWarning` event on the observability bus. Lowest-disruption
fix for §1.3's invisibility problem.

### 3.6 Documentation-as-capability matrix

Generated table from a single source of truth.

---

## 4. Proposed guidelines

Two questions narrow the choice for any new field on a `Common*Request`.

**Q1.** Is the gap pinned to "which Layer the caller picked"
(blanket) or does it depend on the _contents_ of the request
(data-driven)?

**Q2.** If data-driven: would silently dropping the field make the
caller's downstream code do the wrong thing — or just give slightly
worse output?

### 4.1 The matrix

| #     | Scenario                                                                                                                              | Mechanism                                                                                                                                                                                                                            | What the caller sees                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **Whole method unavailable on this Layer.** _e.g. `streamSynthesisFrom` on the sync Inworld Layer; realtime methods on a non-realtime Layer._ | **Service-level marker** (`TtsIncrementalText`, `SttStreaming`, `MultiSpeakerTts`). Top-level helper requires it in `R`; supporting Layers ship it.                                                                                  | Type error at `Effect.runPromise` — _before_ the call runs.                                                                                                                                                    |
| **A′** | **Per-modifier capability within a method.** _e.g. `diarization`, `wordTimestamps`, `cacheControl`, `seed`, `structured<T>`._ | **Per-modifier marker** + `requireX` combinator (see §4.2 for the NARROW vs GATE-ONLY split). Spike at [capabilities-spike/index.ts](../experiments/capabilities-spike/index.ts). | Type error at `Effect.runPromise` if no supporting Layer in scope. Optionally narrows the result type (NARROW case).                                                                                                                       |
| **B** | **Identity-typed input has a fixed set of valid values.** _e.g. `voiceId` on OpenAI; `model` on Anthropic._                          | **Type-level narrowing** on the provider's typed request (`Omit<CommonX, "field"> & { field: LiteralUnion }`).                                                                                                                       | Autocompletion shows the valid values. Invalid values are a TS error.                                                                                                                                          |
| **C** | **One provider exposes multiple sub-APIs that differ in more than one field.** _e.g. Google Cloud TTS `chirp-3-hd` vs `gemini-tts`; Lyria clip vs pro._ | **Tagged-union request type** with `family: "..."`. Each branch narrows its own fields; dispatch is a single `switch`.                                                                                                              | Picking a `family` narrows the whole request via TS discrimination.                                                                                                                                            |
| **D** | **Data-dependent gap, honoring the field is load-bearing.** _e.g. cmu-arpabet pronunciation on a provider that can't approximate it; image-on-text-embedding._ | **Runtime `AiError.Unsupported`** with `capability`, `reason`, and the offending field name.                                                                                                                                         | Typed failure. Caller pattern-matches on `_tag === "Unsupported"`.                                                                                                                                             |
| **E** | **Data-dependent gap, field is advisory.** _e.g. `task` on `gemini-embedding-2`; `instructions` on `tts-1`; STT `prompt` biasing._   | **Warn-and-drop**: `Effect.logWarning` with `{ field, value, reason }`, plus a `@capability advisory` docstring tag.                                                                                                                 | Successful result; structured warning on the observability hook.                                                                                                                                               |
| **F** | **Wire-shape mismatch — the caller's input can't be POSTed.** _e.g. URL `AudioSource` to an inline-only provider._                  | **`AiError.InvalidRequest`** with `param` pointing at the offending field.                                                                                                                                                           | Typed failure; remediation is "fix your call site", distinct from "switch provider".                                                                                                                           |

### 4.2 Per-modifier markers: NARROW vs GATE-ONLY

Row **A′** splits further. Per-modifier markers always gate
configuration; some _additionally_ narrow the result type.

> **Narrow** the result field iff its presence is determined by
> (capability + request) alone — **not** by properties of the input
> data.

The pattern of NARROW cases: the field's value is a property of the
**request execution**, not the model's output. Seed echo, cache
token counts, schema-validated parse — computed at the boundary, not
emitted by the model freely.

The pattern of GATE-ONLY cases: even with the provider supporting the
capability and the caller requesting it, the field's presence can
still vary by input (single-speaker audio → no `speakerId`;
empty utterance → no `words[]`; model declines to think → no
`reasoning`).

**Classification of modifiers in scope:**

| Service | Modifier | Verdict | Reason |
|---|---|---|---|
| Transcription | `diarization` | GATE-ONLY | `speakerId` depends on multi-speaker audio |
| Transcription | `wordTimestamps` | GATE-ONLY | `words[]` depends on audio content |
| Transcription | `language` hint | GATE-ONLY | Output shape unchanged |
| Embeddings | `task` tuning | GATE-ONLY | Vector shape unchanged |
| TTS | `pronunciations` | GATE-ONLY | Audio shape unchanged |
| TTS | `instructions` | GATE-ONLY | Audio shape unchanged |
| LLM | `thinking` / `reasoning_effort` | GATE-ONLY | Model may decline to think |
| LLM | `parallelToolCalls` | GATE-ONLY | `toolCalls[]` shape unchanged |
| **LLM** | **`cacheControl`** | **NARROW** | Cache token counts always reported when on |
| **LLM** | **`structured<T>`** | **NARROW** | Schema validated server-side; conforming `parsed: T` |
| **Image gen** | **`seed`** | **NARROW** | Provider always echoes / generates a seed |

**GATE-ONLY combinator:**

```ts
export const requireDiarization = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | DiarizationGuarantee> =>
  Effect.flatMap(DiarizationGuarantee.asEffect(), () => eff)
```

No casts. No result-type machinery. Result fields stay optional.

**NARROW combinator:**

```ts
export type Capability = "cacheControl" | "structured"

export type Usage<Caps extends Capability = never> = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: "cacheControl" extends Caps ? number : number | undefined
  // ...
}

export const requireCacheControl = <T, C extends Capability, E, R>(
  eff: Effect.Effect<Result<T, C>, E, R>,
): Effect.Effect<Result<T, C | "cacheControl">, E, R | CacheControlGuarantee> =>
  Effect.flatMap(CacheControlGuarantee.asEffect(), () => eff) as any
```

The `as any` cast bridges what TS can't prove: that the marker in `R`
implies the runtime shape. Audited once at the combinator definition.

### 4.3 Distinguishing rows D and E in practice

D and E both answer Q1 with "data-driven". The split on Q2
("load-bearing vs. advisory") is per-field, not per-provider:

- **`pronunciations` is almost always D** — the _point_ of the
  override is correct pronunciation. Today we treat it as silent E on
  Inworld/ElevenLabs — that's a bug.
- **`prompt` (vocab biasing) on STT is E** — dropping gives worse
  transcripts, not wrong ones.
- **`temperature` / `topP` are E** — clamping/ignoring still produces
  a valid completion.

When unsure, default to D. Promoting D → E is a breaking change (now
silent), while E → D is additive (now visible).

### 4.4 Consistency fixes that fall out of the matrix

1. **§1.2(c) "kept-but-rejected-unconditionally" must go.** Either
   narrow the field out (row B) or downgrade to row E (warn-and-drop).
   Under the new per-modifier framework, this is also the place to
   *not* register the marker, so consumer `requireX` fails at compile
   time.
2. **§1.3 silent drops need an uplift.** Add `dropUnsupported(field,
   value, reason)` helper + `@capability advisory` docstring
   convention.
3. **§1.5 misuse of `InvalidRequest` for feature gaps.** Image part on
   text-only embedding and multi-part rejection on Jina are row D, not
   F. URL-audio cases stay on F.

---

## 5. Anti-patterns

- **`InvalidRequest` for capability gaps not tied to wire-shape.** Use
  `Unsupported`.
- **Hidden silent drops on fields users care about** (output quality,
  timestamps). Either reject or warn.
- **Capability flags as boolean Layer config.** Tempting for "ship
  marker conditional on `geminiTtsEnabled`", but it makes the service
  value's capabilities depend on runtime config the typechecker can't
  see. Prefer multiple Layers.
- **Per-provider marker types.** Markers are capability-shaped
  (`TtsIncrementalText`, `DiarizationGuarantee`), not provider-shaped
  (no `ElevenLabsSpecial`). Any Layer implementing the capability can
  ship the marker.
- **The "lie" that narrows on the marker alone.** Don't write
  `speakerId: "diarization" extends Caps ? string : string | undefined`
  — single-speaker audio legitimately returns no `speakerId` even on a
  diarizing provider. Narrowing belongs only in the NARROW cases of
  §4.2. (Forgetting this rule was the catalyst for the rewrite — see
  spike comments.)

---

## 6. Open questions

- Should `synthesizeDialogue` survive as a method on the common
  service or factor into its own `DialogueTts` service?
- Should we add markers for "invisible" modifiers like
  `parallelToolCalls` and embedding `task`? Cheap to add, adds API
  surface. Probably yes for fallback ergonomics.
- **Third-party Layer authors.** No enforcement that "if you implement
  diarization, you must register the marker." Forgotten markers leave
  consumers stuck on the lax path.
- **Inter-package wire boundaries.** Narrowed types don't survive JSON
  serialization. Out-of-process consumers see the wide type only.
- Should we add a `CapabilityWarning` value to `AiError` for the
  warn-and-drop path so callers can pattern-match on it without
  turning every degradation into a hard failure?

---

## 7. TL;DR for code review

When introducing a new optional field on a `Common*Request`:

1. **Whole feature missing on this provider** → service-level marker
   (row A). Existing markers: `TtsIncrementalText`, `SttStreaming`, ...
2. **Per-modifier flag** → per-modifier marker + `requireX` combinator
   (row A′). Default to GATE-ONLY; opt into NARROW only if the field's
   presence is purely a function of (capability + request).
3. **Identity-typed input** → narrow on the provider's typed request
   (row B).
4. **Whole provider can't ship the field given specific input** →
   `Unsupported` (row D).
5. **Field is advisory and a degraded output is still useful** →
   warn-and-drop (row E). Never silently.
6. **Wire genuinely can't carry the shape** → `InvalidRequest`
   (row F).
7. Never `InvalidRequest` for "this provider doesn't have that
   feature".

---

## 8. The reference spike

[`experiments/capabilities-spike/index.ts`](../experiments/capabilities-spike/index.ts)
is the worked example. It covers Transcription (all GATE-ONLY),
Embeddings (GATE-ONLY), LLM (mixed: thinking/parallelTC GATE-ONLY,
cacheControl/structured NARROW), and ImageGen (seed NARROW). Each
section has a working example next to a compile-error counterpart
with `@ts-expect-error`. Run:

```
pnpm --filter @effect-uai/spike-capabilities typecheck
```

Two implementation gotchas the spike documents (both burned us during
development):

- The `fallback` combinator's type parameter must be `<const Layers
  extends …>`. Without `const`, TS widens the array literal to a union
  and the tuple-tail recursion silently returns `unknown`.
- Extracting `ROut` from `Layer.Layer<infer Out, …>` requires
  `infer _E, infer _RIn` for the other slots. Using `any, any` makes
  TS resolve `infer Out` to `unknown` (Layer is contravariant in
  ROut).

---

## 9. Violations in the current tree

Cross-referencing the inventory (§1) against the matrix (§4). Each
entry: **location → current behaviour → which row of the matrix it
belongs in → fix**.

### 9.1 Row D mis-classified as silent E (silent drop where reject is correct)

Pronunciation overrides are load-bearing — if dropped, the audio is
wrong. Promote silent → `Unsupported`.

- [InworldSynthesizer.ts:78-95](../packages/providers/inworld/src/InworldSynthesizer.ts#L78-L95) — non-IPA `pronunciations` entries silently skipped. **Fix:** `Unsupported`.
- [ElevenLabsSynthesizer.ts:79-113](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79-L113) — two silent paths. **Fix:** `Unsupported`.

### 9.2 Row D mis-classified as row F (`InvalidRequest` for a feature gap)

The wire _can_ carry the shape; the provider just doesn't support the
feature. Move to `Unsupported`.

- [OpenAIEmbedding.ts:68](../packages/providers/responses/src/OpenAIEmbedding.ts#L68) — image part rejected with `InvalidRequest`. **Fix:** `Unsupported(imageEmbedding)`. (Already addressed in the WIP `Caps: Step 1` work.)
- [JinaEmbedding.ts:138](../packages/providers/jina/src/JinaEmbedding.ts#L138) — multi-part `content[]` rejected with `InvalidRequest`. **Fix:** `Unsupported(multiPartInput)`. (Already addressed.)

URL-audio rejections stay on `InvalidRequest` (genuine row F).

### 9.3 §1.2(c) hybrids — field on type, runtime always rejects

These should either narrow the field out (row B) OR keep it and rely
on absence of the per-modifier marker (row A′ GATE-ONLY) to gate
consumers. The middle ground — field on the type, runtime always
rejects — is wrong.

- [GeminiTranscriber.ts:48-65](../packages/providers/google/src/GeminiTranscriber.ts#L48-L65) — `wordTimestamps`, `diarization` rejected unconditionally. **Fix:** `Omit<...,"wordTimestamps"|"diarization">` on `GeminiTranscribeRequest` (provider has neither). Also: don't ship `DiarizationGuarantee` / `WordTimestampsGuarantee` on the Gemini Layer.
- [OpenAITranscriber.ts:94](../packages/providers/openai/src/OpenAITranscriber.ts#L94) — `diarization` rejected unconditionally. **Fix:** `Omit<...,"diarization">`. Don't ship `DiarizationGuarantee` on the OpenAI Layer. (`wordTimestamps` is correctly row D — only rejected for `model !== "whisper-1"`. Leave that runtime guard; ship the marker on the OpenAI Layer iff configured for whisper-1, or split into `OpenAIWhisper1Layer` + `OpenAIGpt4oTranscribeLayer`.)

### 9.4 Row E that forgot to warn

Field is honored by some models, ignored by others; today the ignore
is silent. Add `Effect.logWarning` (via the proposed `dropUnsupported`
helper).

- [GeminiEmbedding.ts:29-30](../packages/providers/google/src/GeminiEmbedding.ts#L29) — `task` ignored on `gemini-embedding-2`.
- [OpenAIEmbedding.ts:27-31](../packages/providers/responses/src/OpenAIEmbedding.ts#L27) — `task` silently ignored on the generic surface.
- [OpenAISynthesizer.ts:30-31](../packages/providers/openai/src/OpenAISynthesizer.ts#L30) — `instructions` honored only by `gpt-4o-mini-tts`.
- [openai/codec.ts:93](../packages/providers/openai/src/codec.ts#L93) — caller's `sampleRate` ignored.

### 9.5 Row B inconsistency — the `task` field

Same field, three different mechanisms across embedding providers:

| Provider | Today | Correct row |
|---|---|---|
| Jina | Narrows `task: JinaTask` | B ✓ |
| OpenAIEmbedding (typed) | Omits `task` entirely | B ✓ |
| OpenAIEmbedding (generic) | Accepts + silently drops | should warn (9.4) |
| GeminiEmbedding (typed) | Widens to `GoogleEmbeddingTask` | B ✓ |
| GeminiEmbedding (runtime) | Drops silently on `gemini-embedding-2` | should warn (9.4) |

No structural fix — three providers, three valid type surfaces. The
fix is making the generic-Layer drops audible.

### 9.6 Provider-specific fields on the common shape — `DialogueTurn`

Already fixed in this branch. `styleDescription` and per-turn `speed`
were removed from
[SpeechSynthesizer.ts](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts)
in `Caps: Step 1` per the row-B principle that provider-specific knobs
belong on the typed request, not the common shape. Re-add on Hume's
typed turn when Hume lands.

### 9.7 Row C candidates

Not violations strictly, but the matrix says tagged unions are right
when sub-APIs diverge on multiple fields. Today both candidates use
runtime predicates:

- [LyriaGenerator.ts:93](../packages/providers/google/src/LyriaGenerator.ts#L93) — `isClipModel` predicate; candidate for `family: "clip" | "pro"`.
- Google Cloud TTS (not in tree) — carry the `family` discriminator forward.

Lower priority — only convert if the runtime branching grows hairy.

### 9.8 §1.2(a) blanket stubs (informational)

The stubbed `Unsupported` returns for methods covered by markers are
defensive duplicates. Keep for now — revisit if we add a fourth marker
that splits the service further.

### 9.9 Per-modifier markers — green-field adoption

The new framework adds:

- `DiarizationGuarantee` and `WordTimestampsGuarantee` on Transcriber,
  with `requireDiarization` / `requireWordTimestamps` combinators.
- `CacheControlGuarantee` and `StructuredOutputGuarantee` on LLM,
  with NARROW-shape combinators.
- `SeedGuarantee` on ImageGen.
- `fallback` combinator that intersects markers across tiers (already
  validated in the spike).

Adoption order suggested in §10.

### 9.10 Summary count

| Class | Count | Effort |
|---|---|---|
| Row D mis-classified as silent E (9.1) | 2 sites | Mechanical |
| `InvalidRequest` → `Unsupported` (9.2) | 2 sites | Already done in WIP |
| §1.2(c) hybrids → Row B (9.3) | 2 providers | Mechanical (already in WIP for OpenAI/Gemini transcribers) |
| Silent → warn-and-drop (9.4) | 4 sites | Add helper + 4 call sites |
| Per-modifier marker rollout (9.9) | ~6 markers + spike | Moderate |
| Core additions: `dropUnsupported` + `CapabilityWarning` | — | Small |

---

## 10. Suggested adoption order

1. Land the `dropUnsupported` helper + `CapabilityWarning` event in
   core. Unlocks §9.4.
2. Promote 9.2 from WIP to merged. Already half-done.
3. Apply 9.3 — narrow `wordTimestamps`/`diarization` out of Gemini and
   OpenAI typed transcribers. WIP work; keep going.
4. Introduce the first per-modifier marker pair
   (`DiarizationGuarantee`, `WordTimestampsGuarantee`) on Transcriber.
   Add the `fallback` combinator. Pattern lives in the spike already.
5. Apply 9.1 (pronunciation rejections).
6. Apply 9.4 (silent → warn) using the helper from step 1.
7. Add the NARROW-shape markers on LLM and ImageGen
   (`CacheControlGuarantee`, `StructuredOutputGuarantee`,
   `SeedGuarantee`) as the modifier work for those services lands.
