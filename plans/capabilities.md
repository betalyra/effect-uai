# Capability Handling — Inventory & Guidelines

Across the providers we expose, every AI vendor has gaps: OpenAI has no
incremental-text-in TTS, Gemini has no diarization, ElevenLabs only
accepts IPA on some models, OpenAI Embeddings reject image parts, and
so on. The repo currently encodes those gaps in **five different
ways**. This document inventories which approach is used where, names
the trade-offs of each, and proposes guidelines for choosing between
them.

This is a design analysis, not an implementation plan. No production
code is changed by reading it.

---

## 1. The five (and a half) patterns we already use

### 1.1 Compile-time phantom capability markers

A capability is encoded as a `Context.Service<X, void>` tag that the
top-level helper requires in its `R` channel. Provider Layers that
support the capability ship `Layer.succeed(Marker, undefined)`;
providers that don't, simply omit the line. Calling the helper while
only a non-supporting Layer is in scope is a compile-time error at
`Effect.provide`.

Existing markers, all in `packages/core/src`:

- `SttStreaming` — [Transcriber.ts:80](packages/core/src/transcriber/Transcriber.ts#L80)
- `TtsIncrementalText` — [SpeechSynthesizer.ts:166](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L166)
- `MultiSpeakerTts` — [SpeechSynthesizer.ts:179](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L179)
- `MusicInteractiveSession` — [MusicGenerator.ts:68](packages/core/src/music-generator/MusicGenerator.ts#L68)

Registration matrix (ships the marker?):

| Marker                    | inworld sync | inworld realtime                                                              | google Gemini | google Lyria                                                      | elevenlabs sync                                                               | openai sync | openai realtime                                                             |
| ------------------------- | ------------ | ----------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `TtsIncrementalText`      | no           | yes ([:81](packages/providers/inworld/src/InworldRealtimeSynthesizer.ts#L81)) | no            | n/a                                                               | yes ([:292](packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L292)) | no          | n/a                                                                         |
| `MultiSpeakerTts`         | no           | no                                                                            | no            | n/a                                                               | yes ([:293](packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L293)) | no          | n/a                                                                         |
| `SttStreaming`            | no           | yes ([:63](packages/providers/inworld/src/InworldRealtimeTranscriber.ts#L63)) | no            | n/a                                                               | yes ([:181](packages/providers/elevenlabs/src/ElevenLabsTranscriber.ts#L181)) | n/a         | yes ([:60](packages/providers/openai/src/OpenAIRealtimeTranscriber.ts#L60)) |
| `MusicInteractiveSession` | n/a          | n/a                                                                           | n/a           | no ([:368](packages/providers/google/src/LyriaGenerator.ts#L368)) | n/a                                                                           | n/a         | n/a                                                                         |

Registration is always unconditional per Layer — the conditional axis
is which Layer the caller imports (e.g. `InworldSynthesizer` vs.
`InworldRealtimeSynthesizer`). No marker is gated by a runtime config.

### 1.2 Runtime `AiError.Unsupported`

A tagged error in [AiError.ts:97](packages/core/src/domain/AiError.ts#L97). The
docstring is the existing written policy: **request-data-dependent
gaps → runtime `Unsupported`; blanket provider-level gaps → compile-
time markers.** Two clean subcategories show up in the wild:

**(a) "blanket method-not-supported on this Layer"** — stub bodies in
the sync Layer for a method that only exists on the realtime Layer.
These are duplicates of the marker information at runtime, and only
exist because the `SpeechSynthesizerService` interface has all five
methods. Examples:

- [InworldSynthesizer.ts:210](packages/providers/inworld/src/InworldSynthesizer.ts#L210), [:223](packages/providers/inworld/src/InworldSynthesizer.ts#L223), [:234](packages/providers/inworld/src/InworldSynthesizer.ts#L234)
- [GeminiSynthesizer.ts:166](packages/providers/google/src/GeminiSynthesizer.ts#L166), [:176](packages/providers/google/src/GeminiSynthesizer.ts#L176), [:186](packages/providers/google/src/GeminiSynthesizer.ts#L186)
- [OpenAISynthesizer.ts:169](packages/providers/openai/src/OpenAISynthesizer.ts#L169), [:181](packages/providers/openai/src/OpenAISynthesizer.ts#L181), [:191](packages/providers/openai/src/OpenAISynthesizer.ts#L191)
- [OpenAITranscriber.ts:217](packages/providers/openai/src/OpenAITranscriber.ts#L217)
- [GeminiTranscriber.ts:162](packages/providers/google/src/GeminiTranscriber.ts#L162)
- [InworldTranscriber.ts:181](packages/providers/inworld/src/InworldTranscriber.ts#L181)
- [LyriaGenerator.ts:339](packages/providers/google/src/LyriaGenerator.ts#L339)

**(b) "request-data-dependent gap"** — the provider supports the
method in general but not for these inputs. This is the docstring's
"intended" use of `Unsupported`. Examples:

- Output-format codec rejection: [inworld/codec.ts:25](packages/providers/inworld/src/codec.ts#L25), [openai/codec.ts:107](packages/providers/openai/src/codec.ts#L107), [elevenlabs/codec.ts:65](packages/providers/elevenlabs/src/codec.ts#L65), [GeminiSynthesizer.ts:67](packages/providers/google/src/GeminiSynthesizer.ts#L67)
- Realtime input-format rejection: [inworld/realtimeStt.ts:39](packages/providers/inworld/src/realtimeStt.ts#L39), [openai/realtimeStt.ts:33](packages/providers/openai/src/realtimeStt.ts#L33), [elevenlabs/realtimeStt.ts:23](packages/providers/elevenlabs/src/realtimeStt.ts#L23)
- Model × format: [LyriaGenerator.ts:257](packages/providers/google/src/LyriaGenerator.ts#L257) (clip models reject wav)
- Model × feature: [OpenAITranscriber.ts:85](packages/providers/openai/src/OpenAITranscriber.ts#L85) (word-timestamps only on whisper-1)

**(c) "request-flag-dependent blanket"** — the field is on the request
type but rejected unconditionally when set. This is a hybrid: blanket
at the provider level, but the field is still in the type, so the
caller has no compile-time signal.

- [GeminiTranscriber.ts:48-65](packages/providers/google/src/GeminiTranscriber.ts#L48-L65) — `wordTimestamps`, `diarization`
- [OpenAITranscriber.ts:94](packages/providers/openai/src/OpenAITranscriber.ts#L94) — `diarization`

### 1.3 Silent drops

A field is accepted on the request type but discarded without a log
when the provider can't honor it. Audio still renders.

- **Pronunciations** by encoding:
  - [InworldSynthesizer.ts:78-95](packages/providers/inworld/src/InworldSynthesizer.ts#L78-L95) — IPA kept, others silently dropped
  - [ElevenLabsSynthesizer.ts:79-113](packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79-L113) — two drop paths: whole-array drop on unsupported model + per-item drop for x-sampa, no log
  - Google Cloud TTS (per the chirp-3 work): cmu-arpabet dropped silently
- **Embedding `task`** ignored on some models:
  - [GeminiEmbedding.ts:29-30](packages/providers/google/src/GeminiEmbedding.ts#L29) — "honoured by `gemini-embedding-001`; ignored by `gemini-embedding-2`"
  - [OpenAIEmbedding.ts:27-31](packages/providers/responses/src/OpenAIEmbedding.ts#L27) — accepts and silently ignores `task` on the generic surface
- **`instructions`** on OpenAI TTS: [OpenAISynthesizer.ts:30-31](packages/providers/openai/src/OpenAISynthesizer.ts#L30) — honored only by `gpt-4o-mini-tts`, silently ignored on `tts-1` / `tts-1-hd`
- **`styleDescription` on `DialogueTurn`** ([SpeechSynthesizer.ts:86](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L86)) — defined in core but referenced by **zero** adapters. Effectively dropped everywhere without acknowledgment.
- **Sample rate on OpenAI**: [openai/codec.ts:93](packages/providers/openai/src/codec.ts#L93) — `sampleRate` ignored; provider reports realized format on the output
- Realtime error frames: [inworld/realtimeTts.ts:117](packages/providers/inworld/src/realtimeTts.ts#L117), [elevenlabs/realtimeTts.ts:97](packages/providers/elevenlabs/src/realtimeTts.ts#L97) — `Effect.logWarning` but **no** typed error surfaced

No provider currently `logWarning`s for a dropped capability field —
silent drops are truly silent.

### 1.4 Type-level request narrowing (`Omit` and re-typing)

Every provider request is `Omit<CommonX, ...> & { ...narrowed }`. The
common pattern is to narrow `model` to a literal union, and for TTS
also `voiceId`. Embedding providers further narrow or remove `task`
and `encoding`:

- [JinaEmbedding.ts:68](packages/providers/jina/src/JinaEmbedding.ts#L68) — narrows `model`, `task`, `encoding`; service generic on `E extends JinaEncoding` to propagate result shape
- [OpenAIEmbedding.ts:32](packages/providers/responses/src/OpenAIEmbedding.ts#L32) — narrows `model`; removes `task` and `encoding` entirely from the typed surface
- [GeminiEmbedding.ts:42](packages/providers/google/src/GeminiEmbedding.ts#L42) — narrows `model`, widens `task` to an 8-value enum, adds `title`

Notably, **the same field (`task`) is handled three different ways
across three packages**: narrowed (Jina), removed (OpenAI), widened

- silently dropped on some models (Google). That is exactly the
  inconsistency this document is meant to address.

### 1.5 `InvalidRequest` used for capability gaps

A grey zone: when a wire-API shape mismatch is reported, providers
sometimes use `InvalidRequest` for what is really a capability gap.
The docstring intent of `InvalidRequest` is "the request shape is
malformed"; these usages stretch that.

- URL `AudioSource` rejected on providers that only accept inline
  base64: [inworld/InworldTranscriber.ts:59](packages/providers/inworld/src/InworldTranscriber.ts#L59), [google/geminiSpeechCodec.ts:11](packages/providers/google/src/geminiSpeechCodec.ts#L11), [elevenlabs/codec.ts:86](packages/providers/elevenlabs/src/codec.ts#L86), [openai/codec.ts:16](packages/providers/openai/src/codec.ts#L16)
- Image part rejected on text-only embedding: [OpenAIEmbedding.ts:68](packages/providers/responses/src/OpenAIEmbedding.ts#L68)
- Multi-part embedding input rejected: [JinaEmbedding.ts:138](packages/providers/jina/src/JinaEmbedding.ts#L138)
- Image URL rejected on Gemini Embedding: [GeminiEmbedding.ts:110](packages/providers/google/src/GeminiEmbedding.ts#L110) — docstring at :116 explicitly frames this as "reject up front rather than silently dropping" (a deliberate choice).

### 1.6 (Half-pattern) Disjoint / tagged-union requests

**Not yet used in tree.** The chirp-3 plan proposed
`family: "chirp-3-hd" | "gemini-tts"` to discriminate sub-API surfaces
within one provider. The Lyria `clip` vs `pro` model split is the
closest equivalent in code today, but it lives as a runtime predicate
([isClipModel at LyriaGenerator.ts:93](packages/providers/google/src/LyriaGenerator.ts#L93)), not on the type.

---

## 2. Trade-offs of each pattern

### Phantom capability marker (§1.1)

**Pros**

- Type error at provide time — caller sees the gap before running.
- Zero runtime cost (`void` service).
- Composable: one marker per capability, providers opt in piecemeal.
- The `R` channel is the natural place to talk about "what this
  computation requires of its environment".

**Cons**

- Adds a tag to import; verbose for callers who already provide the
  parent service.
- Doesn't help in dynamic provider selection (e.g. a `selectByModel`
  function returns a `SpeechSynthesizerService` — the marker is gone).
- Only works for **blanket** gaps that are pinned to which Layer is in
  scope. Can't express "available on some models but not others"
  unless we factor those into separate Layers (rare and awkward).
- Discovery: a user who calls `synthesizeDialogue` and sees a cryptic
  R-channel error needs to know the marker exists. Less self-
  documenting than an autocompletion gap.

### Runtime `Unsupported` (§1.2)

**Pros**

- Granular: can carry `capability`, `reason`, and request context.
- Handles request-data dependence cleanly (model × feature × format).
- No type-level acrobatics required.

**Cons**

- Caller must remember to handle it — `AiError` is a large union and
  the dev experience often becomes "catch-all then log".
- For **blanket method-not-supported** (the §1.2(a) stubs), it
  duplicates the marker's information and is **strictly worse**:
  the marker would catch it at compile time, and the runtime stub
  only fires if the marker is missing in `R` _and_ the caller never
  hit the type check. We currently ship both, which is belt-and-
  braces but increases surface.
- §1.2(c) ("request-flag-dependent blanket") is the worst form:
  field is on the type, runtime rejects unconditionally. Caller has
  no autocompletion signal that the flag does nothing here.

### Silent drop (§1.3)

**Pros**

- Maximizes "it just works" for cross-provider code — the same
  request runs against any provider, output is correct-ish.
- No error to plumb through.
- Right answer when the field is _advisory_ and dropping it doesn't
  change correctness (e.g. `prompt` vocab biasing on a provider that
  ignores prompts).

**Cons**

- Invisible to the caller: silently degraded output, no warning, hard
  to diagnose when something sounds wrong.
- Across providers we are **inconsistent**: pronunciations are
  dropped, but `wordTimestamps=true` is rejected. Caller can't
  predict which fields silently fail.
- No telemetry hook: even with observability turned on, there's
  nothing to count.

### Type-level narrowing (`Omit` / re-typing) (§1.4)

**Pros**

- Best dev experience for fields tied to identity (model name,
  voice ID): autocompletion just works.
- Removes invalid choices entirely; no runtime check needed.
- Composes well with provider-specific extensions (`thinkingBudget`,
  `voiceSettings`).

**Cons**

- Forces a per-provider request type, so cross-provider code needs an
  adapter layer (the `fromCommon`-style helpers we already write).
- Doesn't compose with the _generic_ helper (`SpeechSynthesizer
.synthesize(req)` always takes `CommonSynthesizeRequest`).
- Inconsistent today: `task` is narrowed by one provider, removed by
  another, kept-and-dropped by a third.

### `InvalidRequest` for capability gaps (§1.5)

**Pros**

- Conceptually close enough that callers usually do the right thing
  (the `param` field carries the offending field name).
- Already what wire APIs return for these — feels natural to mirror.

**Cons**

- Conflates "you sent a malformed request" with "this provider
  doesn't support what you asked for". Different remediation: one is
  fix-the-call, the other is switch-provider or accept-the-gap.

---

## 3. Patterns we haven't fully explored

### 3.1 Service-shape variance via per-Layer typing

Today's `SpeechSynthesizerService` has all five methods, so every
Layer must implement all five (real or stub). An alternative: have
the **sync** Layer expose a `SpeechSynthesizerSync` service with three
methods, and the **realtime** Layer additionally expose
`SpeechSynthesizerRealtime` (or extend it). The top-level helpers
require the appropriate service. This collapses §1.1 markers and
§1.2(a) stubs into one mechanism:

```ts
class TtsSync extends Context.Service<TtsSync, { synthesize, streamSynthesis, synthesizeDialogue? }>() { ... }
class TtsIncremental extends Context.Service<TtsIncremental, { streamSynthesisFrom }>() { ... }
```

Pro: methods that don't exist don't appear on the service value, so
typos and stubs disappear. Con: callers need to provide more than one
service. And `synthesizeDialogue` doesn't cleanly split — it's a
sync method available on a _subset_ of sync Layers — which is exactly
what the marker pattern was for in the first place.

### 3.2 Tagged-union request types

The chirp-3 plan's `family` discriminator. For providers that host
genuinely different sub-APIs (Cloud TTS `chirp-3-hd` vs `gemini-tts`,
Anthropic `messages` vs `count_tokens`, Lyria `clip` vs `pro`),
this is the cleanest fit: caller picks the variant, TypeScript
narrows the rest of the request based on `family`, dispatch is a
single `switch`.

Pro: exhaustive at compile time, no `Unsupported` round-trip, no
`Omit` gymnastics. Con: one more discriminator the caller has to
learn for each provider. Recommended only when the variants differ
in **more than one field** (otherwise narrowing `model` does the job).

### 3.3 Schema-based validation at the boundary

Encode capability gates as `Schema.filter` refinements on the request
type, decode once at the provider entry, and produce typed errors as
the parsed `Either`. Already a natural fit in Effect.

Pro: declarative, one-place-to-look, gives us a typed error pipeline
that distinguishes per-field gaps. Con: heavier ceremony for what is
often a one-line guard; adds Schema as a hard runtime dep for every
adapter.

### 3.4 Smart constructors

`Chirp3HdRequest.make(input)` returns `Effect<Chirp3HdRequest,
InvalidRequest | Unsupported>` — the construction is the validation
point. The provider's `synthesize` then takes only the branded type
and can't fail-on-shape.

Pro: failure is co-located with the data that caused it; downstream
code is cleaner. Con: adds an indirection for every call site;
Effect-typed constructors are awkward when the request is built from
upstream data in a non-Effect context.

### 3.5 Warn-and-drop with a structured observability hook

Today's silent drops, but with a `Effect.logWarning` carrying the
field name + reason. Cheap to add, restores discoverability without
breaking call-sites. Could also be plumbed through the existing
observability layer ([packages/core/src/observability](packages/core/src/observability/)) so
production code can opt into "fail on capability degradation" as a
config flag.

Pro: lowest-disruption way to fix §1.3's invisibility problem. Con:
warnings get tuned out; doesn't help typecheck-time discovery.

### 3.6 Documentation-as-capability (capability matrix in docs)

Generated table from a single source of truth showing which provider
× method × option combinations are supported. Doesn't change the
code, but makes the cross-provider story navigable. Already partially
exists in scattered docstrings; could be consolidated.

---

## 4. Proposed guidelines

Two questions, asked in order, narrow the choice to one mechanism.

**Q1.** Is the gap pinned to "which Layer the caller picked"
(blanket) or does it depend on the _contents_ of the request
(data-driven)?

**Q2.** If data-driven: would silently dropping the offending field
make the caller's downstream code do the wrong thing — or just give
slightly worse output?

The matrix below maps each combination to its mechanism, with a
concrete example, the diagnostic question that puts a case in this
row, and what the caller sees.

### 4.1 The matrix

| #     | Scenario                                                                                                                                                                                                                                                                                                                                               | Diagnostic question                                                                                                                                                                        | Mechanism                                                                                                                                                                                | What the caller sees                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A** | **Whole method unavailable on this Layer.** _Example: `streamSynthesisFrom` on `InworldSynthesizer` (sync). The realtime Layer wires it; the sync Layer doesn't._                                                                                                                                                                                      | "Is the gap fully determined by which Layer is in scope, with no input that could change the answer?"                                                                                      | **Compile-time phantom marker** (`TtsIncrementalText` etc.) on the top-level helper's `R` channel. Provider Layers that support it ship `Layer.succeed(Marker, undefined)`; others omit. | Type error at `Effect.provide` — _before_ the call runs. No runtime AiError to handle.                                                                             |
| **B** | **Identity-typed input has a fixed set of valid values.** _Example: `voiceId` on OpenAI is exactly the six Aria/Echo/... voices; `model` on Anthropic is the Claude lineup._                                                                                                                                                                           | "Is the set of valid values for this field known at compile time and unlikely to grow per-call?"                                                                                           | **Type-level narrowing** on the provider's typed request (`Omit<CommonX, "field"> & { field: LiteralUnion }`). Apply `Omit` + narrow consistently.                                       | Autocompletion shows the valid values. Invalid values are a TS error. No runtime branch needed.                                                                    |
| **C** | **One provider exposes multiple sub-APIs that differ in more than one field.** _Example: Google Cloud TTS has `chirp-3-hd` (no prompt, simple voice name) and `gemini-tts` (prompt, model+voice combo) on the same endpoint. Lyria has `clip` vs `pro` with different body shapes._                                                                    | "If I tried to put both variants in one request type, would I need optional fields whose presence depends on another field's value?"                                                       | **Tagged-union request type** with `family: "chirp-3-hd" \| "gemini-tts"`. Each branch narrows its own fields; dispatch is a single `switch`.                                            | Picking a `family` narrows the whole request via TS discrimination. No invalid combinations representable.                                                         |
| **D** | **Data-dependent gap, honoring the field is load-bearing.** _Example: `wordTimestamps: true` on a model that doesn't emit them; image part on a text-only embedding model; cmu-arpabet pronunciation on a provider that can't even approximate it._                                                                                                    | "If we silently dropped this field, would the caller's downstream code do the wrong thing — render a UI with no timestamps, embed text instead of an image, mispronounce a critical word?" | **Runtime `AiError.Unsupported`** with `capability`, `reason`, and the offending field name. Reject at the adapter entry, before any wire call.                                          | Typed failure in the Effect channel. Caller pattern-matches on `_tag === "Unsupported"` and either falls back to another provider or surfaces a user-facing error. |
| **E** | **Data-dependent gap, field is advisory.** _Example: `task: "retrieval.query"` on `gemini-embedding-2` (which ignores task hints — embeddings are still valid, just not task-optimized); `instructions: "speak softly"` on OpenAI's `tts-1` (only `gpt-4o-mini-tts` honors it); per-turn `styleDescription` on a dialogue API without per-turn knobs._ | "If we silently dropped this field, is the output still semantically correct — just less tailored?"                                                                                        | **Warn-and-drop**: `Effect.logWarning` with `{ field, value, reason }`, plus a `@capability advisory` docstring tag on the field. Audio/embeddings/text still produced.                  | Successful result; structured warning emitted on the observability hook. A future strict-mode config flag can escalate to error. Never silently.                   |
| **F** | **Wire-shape mismatch — the caller's input can't be POSTed at all.** _Example: passing a URL `AudioSource` to a provider whose API only accepts inline base64 bytes (Inworld, Gemini speech, OpenAI audio)._                                                                                                                                           | "Is this 'you handed me input I can't even put on the wire' rather than 'this provider doesn't do feature X'?"                                                                             | **`AiError.InvalidRequest`** with `param` pointing at the offending field.                                                                                                               | Typed failure; remediation is "fix your call site to provide inline bytes", distinct from "switch provider".                                                       |

### 4.2 Distinguishing rows D and E in practice

D and E both answer Q1 with "data-driven". The split on Q2
("load-bearing vs. advisory") is per-field, not per-provider:

- **`pronunciations` is almost always D** — the _point_ of the
  override is correct pronunciation. Today we treat it as E
  (silent drop on Inworld/ElevenLabs). That's a bug, not a policy
  choice.
- **`prompt` (vocab biasing) on STT is E** — it's a hint to bias the
  decoder; dropping it gives slightly worse transcripts, not wrong
  ones.
- **`diarization: true` is D** — if the caller asked to know who
  said what and we don't return speaker labels, their UI is wrong.
- **`temperature` / `topP` are E** — if a provider clamps them or
  ignores them, you still get a valid completion.

When unsure, default to D. Promoting D → E is a breaking change
(now silent), while E → D is additive (now visible).

### 4.3 Consistency fixes that fall out of the matrix

1. **§1.2(a) blanket stubs are duplicative.** They exist because the
   service interface has all five methods. Either (a) keep them but
   document as defensive (the marker is the contract), or (b) factor
   the service into per-capability shapes (§3.1). Recommendation:
   keep for now; revisit if we add a third capability marker that
   splits the service further.

2. **§1.3 silent drops need an uplift.** A single helper —

   ```ts
   const dropUnsupported = (field: string, value: unknown, reason: string) =>
     Effect.logWarning("[provider] dropping unsupported field", { field, value, reason })
   ```

   plus the `@capability advisory` docstring convention on the field
   is enough. Cheap.

3. **§1.2(c) "kept-but-rejected-unconditionally" must go.** Either
   narrow the field out of the provider's request type (move to row
   B), or keep it and treat as row E with a warning. The current
   "field is on the type, runtime always rejects when set" is the
   worst of both worlds.

4. **§1.5 misuse of `InvalidRequest` for feature gaps.** Image part on
   text-only embedding ([OpenAIEmbedding.ts:68](packages/providers/responses/src/OpenAIEmbedding.ts#L68))
   and multi-part rejection on Jina
   ([JinaEmbedding.ts:138](packages/providers/jina/src/JinaEmbedding.ts#L138))
   are row D, not row F. The URL-audio cases are genuinely row F
   (wire can't carry the shape). Tighten the dividing line.

---

## 5. Anti-patterns to avoid

- **`InvalidRequest` for capability gaps not tied to wire-shape**
  (rare today; called out in §1.5). Use `Unsupported` instead.
- **Hidden silent drops on fields the user almost always cares
  about** (output quality, timestamps). Either reject or warn — not
  both nothing.
- **Capability flags as boolean Layer config.** Tempting for "ship
  marker conditional on `geminiTtsEnabled`", but it makes the
  service value's capabilities depend on runtime config the
  typechecker can't see. Prefer multiple Layers.
- **Per-provider marker types.** Markers should be capability-shaped
  (`TtsIncrementalText`, `MultiSpeakerTts`), not provider-shaped
  (no `ElevenLabsSpecial`). The whole point is the marker is
  satisfied by any Layer implementing the capability.

---

## 6. Open questions

- Should `synthesizeDialogue` survive as a method on the common
  service, or factor into its own service type (`DialogueTts`) that
  only multi-speaker providers implement? Today it's a method with a
  marker; tomorrow it could be a service. The deciding factor is
  whether we expect _every_ TTS Layer to want the dialogue method's
  signature in its type.
- Is `styleDescription` worth keeping in core if no provider
  implements it? Either implement it on Hume Octave-2 (the only
  provider that has it) and document the rest as warn-and-drop, or
  remove it from `DialogueTurn` and let providers that support it
  add it on their per-turn extension.
- Should we add a `CapabilityWarning` value to `AiError` for the
  warn-and-drop path so callers can pattern-match on it without
  turning every degradation into a hard failure? Probably yes if we
  want to fix §1.3 properly.

---

## 7. If we had free reign — what would change?

A summary of opinions, separated into "keep", "drop", "change", and
"add".

### Keep — all six classes survive

The six mechanisms in the matrix each cover a genuinely distinct
case. There isn't a single mechanism that subsumes the others
without becoming awkward in 80% of uses:

- **Marker** is the only way to get a _compile-time_ error for
  a Layer-level gap.
- **Narrowing** is the only way to get autocompletion on a known
  set of values.
- **Tagged union** is the only way to keep "this combination is
  representable" honest when sub-APIs diverge.
- **`Unsupported`** is the only way to refuse a wire call when the
  _data_ triggers the gap and a silent miss would be a bug.
- **Warn-and-drop** is the only way to keep cross-provider code
  ergonomic for fields that are advisory hints.
- **`InvalidRequest`** is the right tool when the input can't be
  marshalled to the wire at all.

Trying to collapse two of these always punishes a third case.

### Drop — silent drops with no log

The only mechanism that should go away entirely. Every silent drop
today is either (a) a row D case mis-classified as row E (e.g.
pronunciations dropped on Inworld/ElevenLabs) or (b) a row E case
that just forgot to emit a warning. Once row E _always_ warns, there
is no remaining justification for true silence.

Concrete deletions:

- The silent path in [InworldSynthesizer.ts:78-95](packages/providers/inworld/src/InworldSynthesizer.ts#L78-L95)
  (`applyPronunciations` skipping non-IPA) — promote to row D
  (`Unsupported`) since pronunciation is load-bearing.
- The silent paths in [ElevenLabsSynthesizer.ts:79-113](packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79-L113)
  — same.
- The silent ignore of `task` on Gemini embedding-2 — promote to row
  E warn-and-drop.
- The silent ignore of `instructions` on OpenAI `tts-1` — same.

### Change — three structural fixes

1. **Remove `styleDescription` and per-turn `speed` from core's
   `DialogueTurn`.** Both fields were placed in core
   ([SpeechSynthesizer.ts:83-88](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L83-L88))
   for Hume Octave-2 (not yet implemented). Per the matrix's row-B
   principle, provider-specific knobs belong on provider-typed
   requests (cf. ElevenLabs `voiceSettings`, Cartesia `emotion`).
   Action: remove now; re-add on `HumeDialogueTurn` when Hume lands.
   Breaking change to `@effect-uai/core`'s exported type, but no
   in-tree adapter reads either field. See §9.6 for the action plan.
2. **Tighten `InvalidRequest` vs `Unsupported`.** Image-on-text-
   embedding and multi-part-on-Jina are feature gaps, not shape
   errors. Move to `Unsupported`. Keep the URL-audio cases on
   `InvalidRequest` (the wire genuinely can't carry the shape).
3. **Eliminate §1.2(c) hybrid rejections.** Today: field is on the
   typed request, but a runtime guard rejects it unconditionally
   ([GeminiTranscriber.ts:48-65](packages/providers/google/src/GeminiTranscriber.ts#L48-L65) for
   `wordTimestamps`/`diarization`,
   [OpenAITranscriber.ts:94](packages/providers/openai/src/OpenAITranscriber.ts#L94) for
   `diarization`). Either narrow the field out (move to row B,
   compile-time) or downgrade to row E warn-and-drop. The middle
   ground is worse than both endpoints.

### Add — three small additions

1. **A `dropUnsupported(field, value, reason)` helper** in core so
   row E is one call, not a free-form `logWarning`. Plus a docstring
   convention: `@capability advisory` on the field.
2. **A `CapabilityWarning` event on the observability bus.** Lets
   strict-mode environments escalate row E to an error via config.
   Mentioned in §6; commit to it.
3. **First-class adoption of the tagged-union pattern** where it
   fits. The Lyria `clip` vs `pro` predicate
   ([LyriaGenerator.ts:93](packages/providers/google/src/LyriaGenerator.ts#L93))
   is a candidate today. If Google Cloud TTS lands later, that's
   another. Don't force it where `model` narrowing suffices.

### Considered but not adopted

- **Service-shape variance** (§3.1). Tempting but punishes callers:
  multiple Services to provide for one logical capability. The
  marker pattern hits the same goal with less ceremony. Revisit only
  if we accumulate 6+ markers on one service.
- **Schema-based boundary validation** (§3.3). Heavier than the
  problem warrants. Most adapter guards are one-line; Schema adds a
  decode step at every entry. Reconsider if request shapes start
  carrying invariants too complex for `if`-guards (e.g. cross-field
  constraints in tool-call schemas).
- **Smart constructors** (§3.4). Awkward when requests are
  assembled outside Effect (UI form state, CLI parsing). Only worth
  it for the most constrained sub-APIs (which the tagged-union
  pattern already handles structurally).

### Net effect

If we made these changes, the only "new" mechanism is the
`dropUnsupported` helper + `CapabilityWarning` event. Everything
else is policy: each existing pattern keeps its lane, the misuses
move to their correct lane, and dead surface comes out. Most of the
work is mechanical edits to a dozen call sites, not architectural
restructuring.

---

## 8. TL;DR for code review

When introducing a new optional field on a `Common*Request`:

1. If it's identity-typed → narrow on the provider's typed request.
2. If a whole provider can't support it at all → compile-time marker
   (and consider a service-shape split if more than one capability
   pins to the same Layer dimension).
3. If specific _inputs_ trigger the gap → `AiError.Unsupported`.
4. If the field is advisory and providers can choose to ignore it →
   `Effect.logWarning` + docstring note. Never silently.
5. Never `InvalidRequest` for "you asked for a feature this provider
   doesn't have".

---

## 9. Violations in the current tree

Cross-referencing the inventory (§1) against the matrix (§4). Each
entry: **location → current behaviour → which row of the matrix it
belongs in → fix**.

### 9.1 Row D mis-classified as row E (silent drop where reject is correct)

Pronunciation overrides are load-bearing — if dropped, the audio is
wrong. Promote silent → `Unsupported`.

- [InworldSynthesizer.ts:78-95](packages/providers/inworld/src/InworldSynthesizer.ts#L78-L95) — non-IPA `pronunciations` entries silently skipped by `applyPronunciations`. **Fix:** per-item `Unsupported` (or row-D-per-item: fail the whole call if any entry is non-IPA).
- [ElevenLabsSynthesizer.ts:79-113](packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79-L113) — two silent paths: whole array dropped when `model ∉ PHONEME_SUPPORTED_MODELS`; per-item drop for `x-sampa`. **Fix:** both paths return `Unsupported`.
- Google Cloud TTS adapter (from the chirp-3 work, not yet in tree) — cmu-arpabet silently dropped. Carry the same rule forward when the package lands.

### 9.2 Row D mis-classified as row F (`InvalidRequest` for a feature gap)

The wire _can_ carry the shape; the provider just doesn't support
the feature. Move to `Unsupported`.

- [OpenAIEmbedding.ts:68](packages/providers/responses/src/OpenAIEmbedding.ts#L68) — image part rejected with `InvalidRequest`. **Fix:** `Unsupported` with `capability: "imageEmbedding"`.
- [JinaEmbedding.ts:138](packages/providers/jina/src/JinaEmbedding.ts#L138) — multi-part `content[]` rejected with `InvalidRequest`. **Fix:** `Unsupported` with `capability: "multiPartInput"`.

The URL-audio rejections ([Inworld](packages/providers/inworld/src/InworldTranscriber.ts#L59), [Gemini speech](packages/providers/google/src/geminiSpeechCodec.ts#L11), [ElevenLabs](packages/providers/elevenlabs/src/codec.ts#L86), [OpenAI](packages/providers/openai/src/codec.ts#L16)) stay on `InvalidRequest` — those are genuine row F (multipart APIs can't accept a URL).

### 9.3 §1.2(c) hybrids — field on type, runtime always rejects

These are the worst-of-both-worlds case. Either move to row B
(narrow out at the type) or row E (warn-and-drop, never reject).

- [GeminiTranscriber.ts:48-65](packages/providers/google/src/GeminiTranscriber.ts#L48-L65) — `wordTimestamps`, `diarization` rejected unconditionally when truthy. Field is still on the typed request. **Fix:** `Omit<...,"wordTimestamps"|"diarization">` on `GeminiTranscribeRequest` (provider genuinely has neither). Move to row B.
- [OpenAITranscriber.ts:94](packages/providers/openai/src/OpenAITranscriber.ts#L94) — `diarization` rejected unconditionally. **Fix:** `Omit<...,"diarization">`. Row B.

The OpenAI `wordTimestamps` rejection at [OpenAITranscriber.ts:85](packages/providers/openai/src/OpenAITranscriber.ts#L85) is **correctly row D** — only rejected for `model !== "whisper-1"`. Leave as-is.

### 9.4 Row E that forgot to warn

Field is honoured by some models, ignored by others; today the
ignore is silent. Add `Effect.logWarning` (via the proposed
`dropUnsupported` helper) and a `@capability advisory` docstring.

- [GeminiEmbedding.ts:29-30](packages/providers/google/src/GeminiEmbedding.ts#L29) — `task` ignored on `gemini-embedding-2`. **Fix:** warn-and-drop.
- [OpenAIEmbedding.ts:27-31](packages/providers/responses/src/OpenAIEmbedding.ts#L27) — `task` accepted via the generic surface and silently ignored. **Fix:** warn-and-drop on the generic Layer's adapter. (The typed `OpenAIEmbedding` request omits `task` entirely — row B — which is the right shape there.)
- [OpenAISynthesizer.ts:30-31](packages/providers/openai/src/OpenAISynthesizer.ts#L30) — `instructions` honoured only by `gpt-4o-mini-tts`, silently ignored on `tts-1` / `tts-1-hd`. **Fix:** warn-and-drop when model is not `gpt-4o-mini-tts`.
- [openai/codec.ts:93](packages/providers/openai/src/codec.ts#L93) — caller's `sampleRate` ignored; provider reports realized format. **Fix:** warn-and-drop when caller-supplied `sampleRate` ≠ realized.

### 9.5 Row B inconsistency — the `task` field

Same field, three different mechanisms across embedding providers
([§1.4](#))[:](#)

| Provider                        | Today                                  | Correct row       |
| ------------------------------- | -------------------------------------- | ----------------- |
| Jina                            | Narrows `task: JinaTask`               | B ✓               |
| OpenAIEmbedding (typed)         | Omits `task` entirely                  | B ✓               |
| OpenAIEmbedding (generic Layer) | Accepts + silently drops               | should warn (9.4) |
| GeminiEmbedding (typed)         | Widens to `GoogleEmbeddingTask`        | B ✓               |
| GeminiEmbedding (runtime)       | Drops silently on `gemini-embedding-2` | should warn (9.4) |

No structural fix — three providers, three valid type surfaces. The
fix is just to make the generic-Layer drops audible (row E).

### 9.6 Provider-specific fields on the common shape — `DialogueTurn`

[SpeechSynthesizer.ts:83-88](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L83-L88)
defines `DialogueTurn` with `styleDescription?: string` and
`speed?: number`. Both fields were added with one provider in mind —
**Hume Octave-2** — whose differentiator is per-utterance natural-
language acting/emotion direction ([roadmap](plans/stt-tts.md#L315),
line 328: "emotion/acting instructions via natural-language
`description` field per utterance — Octave's differentiator"). Hume
is not yet implemented and is marked "low priority unless emotion-
controlled TTS becomes a request" ([:1181](plans/stt-tts.md#L1181)).

This is in **tension with the rest of the design**: the same file's
docstring for `CommonSynthesizeRequest`
([:34-39](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L34-L39))
explicitly says "Provider-specific extensions (ElevenLabs
`stability` / `similarity_boost`, Cartesia `emotion`, MiniMax `vol`
/ `pitch`, Azure SSML style tags) live on each provider's typed
request which extends this." Per-turn style is the same kind of knob
and should follow the same rule.

**Decision: remove both fields from core's `DialogueTurn` now;
re-add on Hume's typed turn when Hume lands.**

Concrete action plan:

1. **Edit core `DialogueTurn`** at
   [SpeechSynthesizer.ts:83-88](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L83-L88)
   to remove `styleDescription` and `speed`, leaving:
   ```ts
   export type DialogueTurn = {
     readonly voiceId: string
     readonly text: string
   }
   ```
   Drop the paragraph in the docstring that references Hume Octave-2
   and ElevenLabs / Gemini ignore behaviour.
2. **Update `CHANGELOG.md`** for `@effect-uai/core` with a
   **BREAKING** entry: `DialogueTurn` no longer carries
   `styleDescription?` or `speed?` per turn. Note the migration
   path: provider-specific per-turn knobs will live on each
   provider's `DialogueTurn` extension (when implemented).
3. **Audit downstream packages** — none of the existing adapters
   read either field (confirmed in §1.3), so the only mechanical
   change is the type-export shape. Verify with a workspace
   typecheck.
4. **When Hume lands** (separate package, e.g.
   `@effect-uai/hume-speech`), define
   ```ts
   export type HumeDialogueTurn = DialogueTurn & {
     readonly description?: string
     readonly speed?: number
   }
   export type HumeSynthesizeDialogueRequest = Omit<CommonSynthesizeDialogueRequest, "turns"> & {
     readonly turns: ReadonlyArray<HumeDialogueTurn>
   }
   ```
   and have Hume's typed `synthesizeDialogue` accept the narrowed
   request. The generic `SpeechSynthesizer.synthesizeDialogue`
   continues to accept the common (knob-less) shape; callers who
   want per-turn style use Hume's typed surface directly.
5. **Mark the `MultiSpeakerTts` docstring** at
   [SpeechSynthesizer.ts:170-181](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L170-L181)
   to reflect that the marker says nothing about per-turn knobs —
   those are provider-specific.

**Why now, before Hume:** the fields are misleading documentation —
callers reading core today see them and (reasonably) expect
adapters to honor them. Removing closes a documentation lie at the
cost of one breaking-change line in the changelog. Re-adding on the
right type later is mechanical.

**Why not pre-empt the field on a `HumeDialogueTurn` placeholder:**
no Hume code exists; defining the type without the adapter that
reads it just relocates the same problem.

### 9.7 Row C candidates (under-used tagged unions)

Not violations strictly, but the matrix says tagged unions are the
right tool when sub-APIs diverge on multiple fields. Today both
candidates use runtime string predicates instead:

- [LyriaGenerator.ts:93](packages/providers/google/src/LyriaGenerator.ts#L93) — `isClipModel` predicate; clip vs pro differ on body shape and accepted output format ([:257](packages/providers/google/src/LyriaGenerator.ts#L257) rejects wav for clip). Candidate for `family: "clip" | "pro"`.
- Google Cloud TTS (not yet in tree) — `chirp-3-hd` vs `gemini-tts` differ on voice naming, prompt support, and model field. Carry the `family` discriminator forward when the package lands.

Lower priority — only convert if the runtime branching grows
hairier.

### 9.8 §1.2(a) blanket stubs (informational)

The stubbed `Unsupported` returns for methods covered by markers
([Inworld](packages/providers/inworld/src/InworldSynthesizer.ts#L210), [Gemini](packages/providers/google/src/GeminiSynthesizer.ts#L166), [OpenAI](packages/providers/openai/src/OpenAISynthesizer.ts#L169), [Lyria](packages/providers/google/src/LyriaGenerator.ts#L339)) are defensive duplicates. Per §4.3.1, **keep for now** — revisit if we add a fourth marker that splits the service further.

### 9.9 Summary count

| Class                                                                | Count                      | Effort                                                  |
| -------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------- |
| Row D mis-classified as silent E (9.1)                               | 3 sites                    | Mechanical                                              |
| `InvalidRequest` → `Unsupported` (9.2)                               | 2 sites                    | Mechanical                                              |
| §1.2(c) hybrids → Row B (9.3)                                        | 3 fields × 2 providers     | Mechanical (delete from type + delete runtime guard)    |
| Silent → warn-and-drop (9.4)                                         | 4 sites                    | Add helper + 4 call sites                               |
| `DialogueTurn` reshape (9.6)                                         | 2 fields removed from core | Small — but a breaking-change entry in core's CHANGELOG |
| Row C conversion (9.7)                                               | 1 site (Lyria)             | Moderate — touches body codec                           |
| Core additions: `dropUnsupported` helper + `CapabilityWarning` event | —                          | Small                                                   |

Total: roughly a dozen edited files plus one helper added to core.
No architectural restructuring required.
