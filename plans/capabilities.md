# Capability Handling — Inventory & Guidelines

Across the providers we expose, every AI vendor has gaps: OpenAI has
no incremental-text-in TTS, Gemini has no diarization, ElevenLabs
only accepts IPA on some models, OpenAI Embeddings reject image
parts, and so on. This document inventories the mechanisms we use,
names the trade-offs of each, and gives a decision rule for choosing
between them.

## TL;DR — the whole policy in five paragraphs

**The default capability story is lax.** Helpers return optional
fields; callers narrow at the call site. Provider adapters translate
gaps into one of three runtime behaviors based on caller intent: shape
mismatches → `AiError.Unsupported`; explicit features the provider
drops on the floor → `warnDropped` (structured warning); tuning
knobs the provider always interprets → silent. This covers ~90% of
real use and works against every provider including aggregators.

**Don't maintain per-model capability tables in adapters.** If the
gap is per-Layer (every model rejects the field), proactive guard is
fine. If the gap is per-model (some models accept, some don't, the
list churns): **send the request and translate the provider's
error.** OpenRouter / HuggingFace / Together / "auto" routers
_always_ pass through — we have no chance of maintaining their
matrices and no business trying.

**Per-modifier capability markers are an experimental strict path
for callers who need a compile-time guarantee** — compliance, audit,
accessibility. Failure-not-degradation rule + documented consumer +
layer-level not model-level. The library-wide marker list is curated
to ~15 across all current and future services (§7); it is not "one
marker per modifier." Markers carry `@experimental` JSDoc on the
per-modifier ones (the set may evolve); the mechanism itself is
stable.

**Request types narrow only when the field has a fixed enum**
(model, voice ID). Don't narrow for free strings or boolean toggles.

**`InvalidRequest` is for wire-shape mismatches only** (URL where
bytes expected). Not for feature gaps.

Two levels of capability live in this design:

- **Service-level markers** — does this Layer expose this method at
  all? `TtsIncrementalText`, `SttStreaming`, `MultiSpeakerTts`,
  `MusicInteractiveSession`, the `Sandbox*` family. Stable, already
  in tree. Apply to every provider including aggregators.
- **Per-modifier markers** — within a method, is this modifier
  honored? `DiarizationGuarantee`, `WordTimestampsGuarantee`,
  `ToolCallingGuarantee`, etc. **Experimental set.** Live
  co-located with their parent service in the main module, marked
  `@experimental` via JSDoc.

---

## 1. The default path — lax + runtime

Every top-level helper (`Transcriber.transcribe`,
`SpeechSynthesizer.synthesize`, …) takes a request with all modifier
fields optional, and returns a result whose modifier-derived fields
are optional. Callers narrow at the call site:

```ts
const r = yield * Transcriber.transcribe({ audio, diarization: true })
for (const w of r.words ?? []) {
  if (w.speakerId !== undefined) console.log(`[${w.speakerId}] ${w.text}`)
  else console.log(w.text)
}
```

When a provider can't honor a field, the adapter classifies into one
of three buckets (§2) and acts accordingly. The lax path composes
with `fallback` (provider tiers in preference order, runtime
`Effect.orElse` between them). Strict guarantees via markers (§6)
are optional on top.

---

## 2. The three-bucket runtime rule

Every optional attribute on a `Common*Request` falls into exactly one
of three buckets. The bucket determines runtime behavior when the
provider can't honor the field.

| Bucket                                               | Test                                                                                                                                                                                                                                                                         | Behavior                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Shape / dimension / count**                        | Caller's downstream code structurally depends on the value being honored exactly (output format, dim, image count, exact pronunciation, what the vector represents). Silent drop = visibly / audibly **broken** output.                                                      | **`AiError.Unsupported`** — prefer pass-through provider error           |
| **Explicit feature, provider has no interpretation** | Caller wrote structured / discrete content (`thinking: true`, `cacheControl: true`, `task: "search_query"`, `prompt: { terms: [...] }`, `negativePrompt: "..."`). Provider drops it on the floor entirely. Silent drop = **less good** output, caller chose this on purpose. | **`warnDropped`** — structured warning via `Effect.logWarning`, see §2.4 |
| **Tuning hint, provider always interprets**          | Continuous knob or hint where the provider has _some_ response (clamp, approximate, partial honor). "Ignoring entirely" isn't a meaningful option — every provider applies some temperature, some language hint.                                                             | **Silent**                                                               |

### 2.1 The discriminator between bucket 2 and bucket 3

The split isn't boolean-vs-continuous; it's **whether the provider
has any structural interpretation of the field at all**.

- `temperature: 0.7` on a provider that clamps to [0, 1] → silent. The provider _interpreted_ the value (clamping is interpretation).
- `prompt: { terms: ["Anthropic"] }` on a provider with no biasing endpoint → warn-and-drop. The provider has no field to interpret it into; it's literal noise.

### 2.2 The field-level failure test

For bucket 1 vs bucket 2, the question is **"if this field is
silently dropped, is the output broken or just less good?"**

- **Broken** (downstream user observes a clear defect): bucket 1 →
  `Unsupported`. Examples: pronunciations (wrong audio for caller's
  configured word), image-on-text-embedder (vector represents
  text-of-prompt instead of image), wrong output dimensions
  (parser breaks), wrong image count (caller expected 4, got 1).
- **Less good** (output still valid, just less optimized / less
  expressive): bucket 2 → warn-and-drop if caller explicitly opted
  in; bucket 3 silent if it's an inherent tuning knob.

This is the same failure-vs-degradation principle that governs
marker selection (§4), applied to the runtime axis instead of the
compile-time axis. Same rule, two surfaces.

### 2.3 Don't maintain per-model capability tables

The runtime check policy:

> When the gap is **per-Layer** (every model this Layer can route to
> rejects the field): proactive guard → `Unsupported`. Cheap, stable.
> Example: Gemini Transcriber rejecting `diarization` (Gemini has no
> diarization at all).
>
> When the gap is **per-model** (some models in this Layer support
> it, some don't, the list churns): **send the request and translate
> the provider's response.** Example: OpenAI rejecting
> `word_timestamps` for non-whisper-1 models — let OpenAI tell us at
> request time, then translate the 400 to `AiError.Unsupported`.
> Don't keep `if (model !== "whisper-1")` in our code.
>
> Adapters MUST translate provider-side capability errors into our
> typed `Unsupported`. This is the error-translation layer's job,
> not a separate capability registry.
>
> For aggregator / model-routing providers (OpenRouter, HuggingFace,
> Together): **always** pass through. We have no business
> maintaining their matrix.

The wins: adapters shrink, accuracy tracks the provider's actual
behavior rather than our (stale) understanding of it, aggregators
cost zero to support.

The cost: errors surface one wire round-trip later for per-model
gaps. Acceptable.

### 2.4 `warnDropped` + `CapabilityWarning`

For bucket 2, provide a structured warning rather than true silence.
Both the `CapabilityWarning` type and the helpers live in
`packages/core/src/capabilities/Capabilities.ts`:

```ts
// packages/core/src/capabilities/Capabilities.ts
export type CapabilityWarning = {
  readonly _tag: "CapabilityWarning"
  readonly provider: string
  readonly capability: string
  readonly field: string
  readonly value?: unknown
  readonly reason: string
}

export const warnDropped = (warning: Omit<CapabilityWarning, "_tag">): Effect.Effect<void> =>
  Effect.logWarning("Capability dropped", { ...warning, _tag: "CapabilityWarning" })

// Shorthand for the common "warn when this field is set" shape;
// the value is attached automatically.
export const warnDroppedWhen = <T>(
  value: T | undefined,
  warning: Omit<CapabilityWarning, "_tag" | "value">,
): Effect.Effect<void> => (value === undefined ? Effect.void : warnDropped({ ...warning, value }))
```

Start log-side (no API surface change). Promote to typed
`AiError.CapabilityWarning` only if a real consumer needs to react
programmatically.

---

## 3. Mechanisms in detail

### 3.1 Compile-time phantom capability markers

A capability is encoded as a `Context.Service<X, void>` tag that the
top-level helper requires in its `R` channel. Provider Layers that
support the capability ship `Layer.succeed(Marker, undefined)`;
providers that don't simply omit the line. Calling the helper while
only a non-supporting Layer is in scope is a compile-time error at
`Effect.provide` (or, more practically, at `Effect.runPromise`, which
requires `R = never`).

**Service-level markers in `packages/core/src` today (stable):**

- `SttStreaming` — [Transcriber.ts:80](../packages/core/src/transcriber/Transcriber.ts#L80)
- `TtsIncrementalText` — [SpeechSynthesizer.ts:162](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L162)
- `MultiSpeakerTts` — [SpeechSynthesizer.ts:180](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L180)
- `MusicInteractiveSession` — [MusicGenerator.ts:68](../packages/core/src/music-generator/MusicGenerator.ts#L68)
- The `Sandbox*` family — [Sandbox.ts:419+](../packages/core/src/sandbox/Sandbox.ts#L419)

**Per-modifier markers — co-located, `@experimental` JSDoc.** Same
mechanism as service-level markers, finer granularity. See §6 for the
experimental status (about the curated _set_, not the mechanism). See
§4 for the rule that governs _when_ to add one and §7 for the curated
library-wide list.

The `requireX` combinator pattern (one per marker) injects the
marker into `R`. Overloaded for `Effect` and `Stream`:

```ts
export const requireDiarization: {
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | DiarizationGuarantee>
  <A, E, R>(str: Stream.Stream<A, E, R>): Stream.Stream<A, E, R | DiarizationGuarantee>
} = ...
```

The `fallback` combinator intersects markers across tiers — a marker
survives only if every tier ships it. See the spike (§13) for the
type-level machinery (uses `<const Layers extends ...>` + `infer _E,
infer _RIn` to avoid TS contravariance traps).

### 3.2 Runtime `AiError.Unsupported`

A tagged error in [AiError.ts:97](../packages/core/src/domain/AiError.ts#L97).
Used for bucket 1 (§2). Three subcategories in the wild:

**(a) "blanket method-not-supported on this Layer"** — stub bodies in
the sync Layer for a method that only exists on the realtime Layer.
Duplicates of service-level marker information at runtime — kept as
defense-in-depth for dynamic dispatch (see §5). Examples:

- [InworldSynthesizer.ts:210](../packages/providers/inworld/src/InworldSynthesizer.ts#L210), [:223](../packages/providers/inworld/src/InworldSynthesizer.ts#L223), [:234](../packages/providers/inworld/src/InworldSynthesizer.ts#L234)
- [GeminiSynthesizer.ts:166](../packages/providers/google/src/GeminiSynthesizer.ts#L166), [:176](../packages/providers/google/src/GeminiSynthesizer.ts#L176), [:186](../packages/providers/google/src/GeminiSynthesizer.ts#L186)
- [OpenAISynthesizer.ts:169](../packages/providers/openai/src/OpenAISynthesizer.ts#L169), [:181](../packages/providers/openai/src/OpenAISynthesizer.ts#L181), [:191](../packages/providers/openai/src/OpenAISynthesizer.ts#L191)
- [LyriaGenerator.ts:339](../packages/providers/google/src/LyriaGenerator.ts#L339)

**(b) "per-Layer data-dependent gap"** — the provider as a whole
can't accept these inputs. Bucket-1 case. Proactive guard is
correct here. Examples:

- Output-format codec rejection: [inworld/codec.ts:25](../packages/providers/inworld/src/codec.ts#L25), [openai/codec.ts:107](../packages/providers/openai/src/codec.ts#L107), [elevenlabs/codec.ts:65](../packages/providers/elevenlabs/src/codec.ts#L65), [GeminiSynthesizer.ts:67](../packages/providers/google/src/GeminiSynthesizer.ts#L67)
- Realtime input-format rejection: [inworld/realtimeStt.ts:39](../packages/providers/inworld/src/realtimeStt.ts#L39), [openai/realtimeStt.ts:33](../packages/providers/openai/src/realtimeStt.ts#L33), [elevenlabs/realtimeStt.ts:23](../packages/providers/elevenlabs/src/realtimeStt.ts#L23)

**(c) "per-model variance"** — some models in this Layer accept the
field, some reject it. Per §2.3, **stop maintaining these
guards**; pass through the provider's error and translate. Examples
to fix:

- [OpenAITranscriber.ts:85](../packages/providers/openai/src/OpenAITranscriber.ts#L85) (word-timestamps only on whisper-1) — drop the per-model check, translate provider 400
- [LyriaGenerator.ts:257](../packages/providers/google/src/LyriaGenerator.ts#L257) (clip models reject wav) — drop the check, translate provider response

**(d) "request-flag-dependent blanket"** — field on type, runtime
always rejects. Move to type-level narrowing (§3.4).

- [GeminiTranscriber.ts:48-65](../packages/providers/google/src/GeminiTranscriber.ts#L48-L65) — `wordTimestamps`, `diarization`
- [OpenAITranscriber.ts:94](../packages/providers/openai/src/OpenAITranscriber.ts#L94) — `diarization`

### 3.3 Silent drops (§1.3 historical inventory)

Today's silent drops, all bucket-2 cases that should warn:

- **Pronunciations** by encoding (per §2.2: bucket 1, not bucket 2 — should `Unsupported`, not warn):
  - [InworldSynthesizer.ts:78-95](../packages/providers/inworld/src/InworldSynthesizer.ts#L78-L95) — IPA kept, others silently dropped
  - [ElevenLabsSynthesizer.ts:79-113](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79-L113) — whole-array drop on unsupported model + per-item drop for x-sampa, no log
- **Embedding `task`** ignored on some models:
  - [GeminiEmbedding.ts:29-30](../packages/providers/google/src/GeminiEmbedding.ts#L29)
  - [OpenAIEmbedding.ts:27-31](../packages/providers/responses/src/OpenAIEmbedding.ts#L27)
- **`instructions`** on OpenAI TTS: [OpenAISynthesizer.ts:30-31](../packages/providers/openai/src/OpenAISynthesizer.ts#L30)
- **Sample rate on OpenAI**: [openai/codec.ts:93](../packages/providers/openai/src/codec.ts#L93) (bucket 3 — provider always interprets via realized-format output; silent is correct)
- **STT `prompt`** when provider has no biasing equivalent

Fixes tracked in §14.

### 3.4 Type-level request narrowing (`Omit` and re-typing)

For identity-typed fields with a fixed set of valid values. Common
case: narrow `model` to a literal union; for TTS also `voiceId`.
Embedding providers further narrow or remove `task` and `encoding`:

- [JinaEmbedding.ts:68](../packages/providers/jina/src/JinaEmbedding.ts#L68) — narrows `model`, `task`, `encoding`
- [OpenAIEmbedding.ts:32](../packages/providers/responses/src/OpenAIEmbedding.ts#L32) — narrows `model`; removes `task` and `encoding` entirely
- [GeminiEmbedding.ts:42](../packages/providers/google/src/GeminiEmbedding.ts#L42) — narrows `model`, widens `task` to an 8-value enum

Don't narrow free strings or boolean toggles. For configuration-gate
fields (booleans, free strings), the lax path applies with optional
per-modifier markers on top.

### 3.5 `InvalidRequest` — wire-shape mismatches only

A grey zone: when a wire-API shape mismatch is reported, providers
sometimes use `InvalidRequest` for what is really a capability gap.
Correct use:

- URL `AudioSource` rejected on inline-only providers: [inworld](../packages/providers/inworld/src/InworldTranscriber.ts#L59), [google](../packages/providers/google/src/geminiSpeechCodec.ts#L11), [elevenlabs](../packages/providers/elevenlabs/src/codec.ts#L86), [openai](../packages/providers/openai/src/codec.ts#L16)

Incorrect use (should be `Unsupported`):

- Image part rejected on text-only embedding: [OpenAIEmbedding.ts:68](../packages/providers/responses/src/OpenAIEmbedding.ts#L68) — already addressed in WIP
- Multi-part embedding input rejected: [JinaEmbedding.ts:138](../packages/providers/jina/src/JinaEmbedding.ts#L138) — already addressed

### 3.6 (Half-pattern) Disjoint / tagged-union requests

**Not yet used in tree.** Proposed for sub-APIs that diverge in more
than one field (Google Cloud TTS `chirp-3-hd` vs `gemini-tts`, Lyria
`clip` vs `pro`). The Lyria split currently uses a runtime predicate
([isClipModel](../packages/providers/google/src/LyriaGenerator.ts#L93)),
not a tagged union. Recommended only when variants differ in **more
than one field**.

---

## 4. When to add a per-modifier marker

> **A per-modifier marker is justified when absence causes wrong
> behavior, not when it causes degraded behavior.**

This is the primary rule. Same failure-vs-degradation principle as
§2.2, applied to the compile-time axis.

- **Failure** = silent drop means the response answers the wrong
  question, the vector represents the wrong thing, the agent can't
  function, the output is unusable for its purpose.
- **Degradation** = silent drop means the same output, just slower /
  more expensive / less optimized.

Failures earn a marker. Degradations get the lax path (bucket 2 or 3
from §2).

### Applying the rule

| Modifier                                 | Verdict  | Reason                                                                                         |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| **STT diarization**                      | ✓ marker | Wrong if caller assumes speaker labels and silently gets none                                  |
| **STT word timestamps**                  | ✓ marker | Wrong if caller assumes timing and silently gets none                                          |
| **LLM tool calling**                     | ✓ marker | Agent unusable without it                                                                      |
| **LLM vision input**                     | ✓ marker | Silent image drop → response about something else                                              |
| **Embedding image input**                | ✓ marker | Silent image drop → vector represents the wrong thing                                          |
| LLM cache control                        | ✗ lax    | Same output, higher cost                                                                       |
| LLM thinking / reasoning                 | ✗ lax    | Same answer, maybe shallower                                                                   |
| LLM parallel tool calls                  | ✗ lax    | Invisible to caller                                                                            |
| LLM structured output                    | ✗ lax    | A typed `LLM.structured<T>()` helper that validates at runtime covers this; marker adds little |
| Image-gen seed                           | ✗ lax    | Reproducibility nice-to-have; runtime echo + log works                                         |
| Image-gen negative prompt                | ✗ lax    | Quality degradation                                                                            |
| TTS pronunciations                       | ✗ —      | Bucket 1 (`Unsupported`); not a marker case (load-bearing data-driven)                         |
| TTS speed / language hint / instructions | ✗ lax    | All bucket 2 or 3                                                                              |
| Embedding task tuning                    | ✗ lax    | Vector quality degradation; bucket 2                                                           |

The library-wide marker list is in §7. New modalities and services
extend by the same rule, lazily.

### 4.1 Marker naming — generic vocabulary, per-service tags

Modality markers (`AudioInputGuarantee`, `VisionGuarantee`,
`VideoInputGuarantee`, etc.) share a vocabulary across services but
the actual tag is per-service: `LLM.AudioInputGuarantee`,
`Embedder.AudioInputGuarantee`, `Live.AudioInputGuarantee`.

Why per-service tags: a provider may support audio input on its LLM
but not on its embedder (asymmetric multimodality is the norm). A
shared tag would force all-or-nothing registration.

Why shared vocabulary: same conceptual question (does this Layer
accept audio?) deserves the same name everywhere. The naming
discipline lives in docs and convention, not in tag identity.

---

## 5. What markers can't do

Markers describe **Layers**, not **values**. They survive
`Layer.provide` and `Layer.merge`; they do not survive extraction to a
service value. A function that returns a `TranscriberService` value
is a marker erasure boundary. The strict path only works through the
helper combinators (`Transcriber.transcribe(...)` +
`Transcriber.requireDiarization`); it does not work for code that
extracts the service and calls methods on the value.

Consequences:

- **Dynamic provider selection** (`selectByConfig(model)` returning a
  service value) cannot be marker-protected. Runtime guards in the
  provider impl are the only safety net. Keep them as
  defense-in-depth.
- **Aggregator providers** (OpenRouter, HuggingFace Inference,
  Together, "auto"-routers) ship `Service` only — no per-modifier
  markers. The underlying model roster churns and aggregators can't
  make guarantees their backends don't. Document each such Layer as
  lax-only.
- **Mixed-model Layers within a single provider** (OpenAI Whisper-1
  vs gpt-4o-transcribe) ship the marker only if **every** routable
  model honors it (pessimistic). If most models in the Layer support
  the capability but one doesn't, the whole Layer is lax. The escape
  hatch — a `withModel<M>()` Layer constructor that narrows the
  marker set to what `M` supports — is introduced lazily, when a
  consumer asks for it, not speculatively.
- **Cross-process wire boundaries.** Marker-derived narrowing
  doesn't survive JSON serialization. Out-of-process consumers see
  the wide / optional types only. Acceptable cost.

The strict path is a tool for callers who need a _guarantee_ a
capability is honored — compliance, audit, accessibility. It is not
the default. The lax path is the default and works against every
Layer.

---

## 6. Per-modifier markers — experimental policy, stable mechanism

**Code location.** Markers and combinators live in the main module,
**co-located with their parent service** — same pattern as
`SttStreaming` today:

```ts
// packages/core/src/transcriber/Transcriber.ts
export class Transcriber extends Context.Service<...> {}
export class SttStreaming extends Context.Service<SttStreaming, void>() {}   // stable
export class DiarizationGuarantee extends Context.Service<...>() {}          // @experimental
export class WordTimestampsGuarantee extends Context.Service<...>() {}       // @experimental
export const requireDiarization = ...                                        // @experimental
export const requireWordTimestamps = ...                                     // @experimental
export const fallback = ...                                                  // combinator stable; marker-intersection @experimental
```

Imports stay simple:

```ts
// Provider
import { DiarizationGuarantee } from "@effect-uai/core"
Layer.succeed(DiarizationGuarantee, undefined)

// Consumer opting into strict path
import { Transcriber } from "@effect-uai/core"
yield* Transcriber.transcribe({...}).pipe(Transcriber.requireDiarization)
```

**Stability signal: JSDoc tag.** Every experimental export carries:

```ts
/**
 * @experimental Per-modifier capability marker. The marker *set* and
 * policy are subject to change — see plans/capabilities.md §7. The
 * type shape itself is stable; the `Context.Service<X, void>` pattern
 * is settled. Providers that honor diarization should ship this via
 * `Layer.succeed(DiarizationGuarantee, undefined)`.
 *
 * @since 0.x.x
 * @category capabilities
 */
export class DiarizationGuarantee extends Context.Service<...> {}
```

**What's experimental:** which capabilities have markers (the §7
curated set), policy around when to add new ones, interaction with
fallback intersection.

**What's stable:** the marker mechanism (`Context.Service<X, void>`
pattern), the `requireX` combinator shape, the `fallback` combinator
itself (its orElse behavior; only the marker-intersection guarantee
carries the experimental tag).

**Why not a separate `@effect-uai/core/experimental` sub-path:**
markers are load-bearing for providers — every supporting provider
package would have to import from `experimental`, blocking stable
releases and making the label dishonest. JSDoc gives the signal
without the friction.

**Promotion path.** Drop the `@experimental` tag once: (a) at least
one external user has reported using the strict path in anger; (b)
the pattern has survived one minor version without API changes; (c)
the limits in §5 are stable enough to commit to.

---

## 7. The curated marker list

Library-wide, the per-modifier markers we plan to support. Additions
follow §4. Removals are possible (experimental policy).

**Tier 1 — Service-level markers (stable, in tree):**

| Marker                    | Service           |
| ------------------------- | ----------------- |
| `SttStreaming`            | Transcriber       |
| `TtsIncrementalText`      | SpeechSynthesizer |
| `MultiSpeakerTts`         | SpeechSynthesizer |
| `MusicInteractiveSession` | MusicGenerator    |
| `Sandbox*` family         | Sandbox           |

**Tier 2 — Per-modifier markers, services we have (`@experimental`):**

| Marker                    | Service     | When                                            |
| ------------------------- | ----------- | ----------------------------------------------- |
| `DiarizationGuarantee`    | Transcriber | Phase 1 — call center / compliance              |
| `WordTimestampsGuarantee` | Transcriber | Phase 1 — captioning / alignment                |
| `ToolCallingGuarantee`    | LLM         | LLM phase — agents unusable without it          |
| `VisionGuarantee`         | LLM         | LLM phase — silent image drop → wrong response  |
| `AudioInputGuarantee`     | LLM         | When audio-input LLM provider lands             |
| `VideoInputGuarantee`     | LLM         | When video-input LLM provider lands             |
| `ImageEmbeddingGuarantee` | Embedder    | Embeddings phase — Cohere v3, Google multimodal |
| `AudioEmbeddingGuarantee` | Embedder    | When audio-multimodal embedder lands            |
| `VideoEmbeddingGuarantee` | Embedder    | When video-multimodal embedder lands            |

**Tier 3 — Future services (markers planned when the service lands):**

| Service                      | Marker                       | Type                          |
| ---------------------------- | ---------------------------- | ----------------------------- |
| Video gen                    | `VideoStreaming`             | service-level                 |
| Video gen                    | `ImageConditioningGuarantee` | per-modifier (image-to-video) |
| Video gen                    | `AudioTrackGuarantee`        | per-modifier                  |
| Live / realtime agent        | `LiveInterruption`           | per-modifier                  |
| Live / realtime agent        | `LiveToolCalling`            | per-modifier                  |
| Live / realtime agent        | `LiveVisionInput`            | per-modifier                  |
| OCR / document               | `LayoutPreservingGuarantee`  | per-modifier                  |
| OCR / document               | `HandwritingGuarantee`       | per-modifier                  |
| Speech-to-speech translation | `VoicePreservingGuarantee`   | per-modifier                  |

**Reranker:** lax-only, no markers (no candidates pass the bar).

**Library-wide ceiling: ~22 markers across everything we'd
realistically need.** That's the maintainable end-state.

The bar for adding to this list:

1. **Failure-not-degradation** per §4.
2. **A real consumer with a documented use case** — not speculation.
3. **At least one provider that ships the capability and at least one
   that doesn't**, so the marker has discriminating value.
4. **The capability is layer-level, not model-level** — see §5 on
   mixed-model Layers.

---

## 8. Trade-offs of each mechanism

### Phantom capability marker (§3.1)

**Pros**

- Type error at provide-time / run-time — caller sees the gap before
  the wire call.
- Zero runtime cost (`void` service).
- Survives `fallback`: a marker stays only if every tier ships it.
- Composable: one marker per capability, providers opt in piecemeal.

**Cons**

- Adds a tag to import; verbose for callers who already provide the
  parent service.
- **Doesn't help in dynamic provider selection** (§5).
- **Doesn't help for aggregators or mixed-model Layers** (§5).
- Discovery: cryptic R-channel error if the caller doesn't know the
  marker exists. Less self-documenting than autocompletion.

### Runtime `Unsupported` (§3.2)

**Pros**

- Granular: carries `capability`, `reason`, and request context.
- Handles request-data dependence cleanly (model × feature × format).
- Pass-through translation scales to aggregators and model-routers.

**Cons**

- Caller must remember to handle it.
- For **blanket method-not-supported** (§3.2(a)), duplicates
  service-level marker information — kept anyway for dynamic-dispatch
  safety.

### `warnDropped` / warn-and-drop (§2.4)

**Pros**

- Visible to operators via structured warning.
- Doesn't interrupt the lax path — caller still gets a usable result.
- Right answer for bucket 2 fields.

**Cons**

- Caller code doesn't see it programmatically (until / unless we
  promote `CapabilityWarning` to a typed error variant).

### Type-level narrowing (`Omit` / re-typing) (§3.4)

**Pros**

- Best DX for identity-typed fields (model, voice ID): autocompletion
  just works.
- Removes invalid choices entirely; no runtime check needed.

**Cons**

- Forces per-provider request types; cross-provider code needs
  adapter layers.
- Doesn't compose with the _generic_ helper.

### `InvalidRequest` for capability gaps (§3.5)

**Pros**

- Conceptually close enough that callers usually do the right thing.

**Cons**

- Conflates "malformed request" with "feature unsupported". Different
  remediation.

---

## 9. Patterns we haven't fully explored

### 9.1 Service-shape variance via per-Layer typing

Today's `SpeechSynthesizerService` has all five methods, so every
Layer implements all five (real or stub). Alternative: factor into
`SpeechSynthesizerSync` + `SpeechSynthesizerRealtime` services. Pro:
methods that don't exist don't appear. Con: callers need multiple
services. Marker pattern hits the same goal with less ceremony.

### 9.2 Schema-based validation at the boundary

Encode capability gates as `Schema.filter` refinements. Heavier than
the problem warrants for most adapter guards.

### 9.3 Smart constructors

`Chirp3HdRequest.make(input)` returns `Effect<..., Unsupported>`.
Awkward when requests are assembled outside Effect.

### 9.4 Documentation-as-capability matrix

Generated table from a single source of truth. Useful for docs site;
doesn't change the runtime model.

---

## 10. Anti-patterns

- **`InvalidRequest` for capability gaps not tied to wire-shape.**
  Use `Unsupported`.
- **Hidden silent drops on bucket-2 fields** (output quality,
  explicit toggles). Either reject (bucket 1) or warn (bucket 2).
- **Per-model capability registries.** Don't keep
  `if (model === "X") reject Y` tables. Pass through provider errors
  and translate. See §2.3.
- **Capability flags as boolean Layer config.** Tempting for "ship
  marker conditional on `geminiTtsEnabled`", but it makes the service
  value's capabilities depend on runtime config the typechecker can't
  see. Prefer multiple Layers.
- **Per-provider marker types.** Markers are capability-shaped
  (`SttStreaming`, `DiarizationGuarantee`), not provider-shaped (no
  `ElevenLabsSpecial`). Any Layer implementing the capability can
  ship the marker.
- **Cross-service shared marker tags.** Use per-service tags with
  shared vocabulary names (§4.1). A single `AudioInputGuarantee`
  shared across LLM / Embedder forces all-or-nothing on providers
  with asymmetric multimodality.
- **The "lie" that narrows on the marker alone.** Don't write
  `speakerId: "diarization" extends Caps ? string : string | undefined`
  — single-speaker audio legitimately returns no `speakerId` even on a
  diarizing provider. Marker-driven result-type narrowing is only
  appropriate when the field's presence is purely a function of
  (capability + request execution) — see Appendix A.
- **Optimistic per-modifier markers on mixed-model Layers.** Shipping
  the marker when only some routable models honor the capability
  defeats the marker's promise. Pessimistic registration is required
  — see §5.
- **Per-modifier markers on aggregator Layers.** Aggregators ship
  `Service` only; capability matrices for their backends are not our
  business.
- **Adding a marker without a documented consumer use case.** The
  bar is real failure (§4), not theoretical completeness.

---

## 11. Open questions

- Should `synthesizeDialogue` survive as a method on the common
  service or factor into its own `DialogueTts` service?
- **Third-party Layer authors.** No enforcement that "if you
  implement diarization, you must register the marker." Forgotten
  markers leave consumers stuck on the lax path. Lint rule?
  Conformance suite?
- Should `CapabilityWarning` become a typed `AiError` variant once a
  consumer needs to pattern-match on it?
- **Promotion criteria from `@experimental`.** Concrete signals
  beyond "someone used it" — usage count? Time-in-API? Survey?

---

## 12. TL;DR for code review

**For every optional field on a `Common*Request`:**

1. **Identity-typed input with fixed enum** → narrow on the
   provider's typed request (§3.4).
2. **Whole feature missing on this provider** (entire method)
   → service-level marker (§3.1). Stable.
3. **Bucket 1** (shape / dim / count / load-bearing content) →
   `AiError.Unsupported`. Prefer pass-through provider error.
4. **Bucket 2** (explicit feature the provider ignores entirely) →
   `warnDropped` with structured warning.
5. **Bucket 3** (tuning hint the provider always interprets) →
   silent.
6. **Wire genuinely can't carry the shape** → `InvalidRequest`
   (§3.5). Never `InvalidRequest` for "this provider doesn't have
   that feature".
7. **Per-model gap** → don't proactively check, translate provider
   error (§2.3).

**For adding a per-modifier marker:**

1. The modifier passes failure-not-degradation (§4).
2. A real consumer has asked for it with a documented use case.
3. At least one provider supports it and at least one doesn't.
4. The capability is layer-level (not model-level — §5).
5. Land it co-located with the service, `@experimental` JSDoc.

---

## 13. The reference spike

[`experiments/capabilities-spike/index.ts`](../experiments/capabilities-spike/index.ts)
is the worked example. It covers Transcription (all GATE-ONLY),
Embeddings (GATE-ONLY), LLM (mixed: thinking / parallelTC GATE-ONLY,
cacheControl / structured NARROW), and ImageGen (seed NARROW). Each
section has a working example next to a compile-error counterpart
with `@ts-expect-error`. Run:

```
pnpm --filter @effect-uai/spike-capabilities typecheck
```

**Note:** the spike includes NARROW examples (cacheControl,
structured, seed) that demonstrate the type-level machinery but are
not on the §7 curated list under current policy. They remain in the
spike as a reference for what the pattern _can_ do — useful if the
policy ever expands. Don't read them as a planned rollout.

Two implementation gotchas the spike documents:

- The `fallback` combinator's type parameter must be `<const Layers
extends …>`. Without `const`, TS widens the array literal to a
  union and the tuple-tail recursion silently returns `unknown`.
- Extracting `ROut` from `Layer.Layer<infer Out, …>` requires `infer
_E, infer _RIn` for the other slots. Using `any, any` makes TS
  resolve `infer Out` to `unknown` (Layer is contravariant in
  ROut).

---

## 14. Violations in the current tree

Cross-referencing the inventory (§3) against the rules (§2, §4).

### 14.1 Bucket 1 mis-classified as silent (pronunciations)

Pronunciation overrides are load-bearing — if dropped, the audio is
wrong. Promote silent → `Unsupported`.

- [InworldSynthesizer.ts:78-95](../packages/providers/inworld/src/InworldSynthesizer.ts#L78-L95) — non-IPA `pronunciations` entries silently skipped. **Fix:** `Unsupported`.
- [ElevenLabsSynthesizer.ts:79-113](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79-L113) — two silent paths. **Fix:** `Unsupported`.

### 14.2 Bucket 1 mis-classified as `InvalidRequest`

The wire _can_ carry the shape; the provider just doesn't support
the feature. Move to `Unsupported`.

- [OpenAIEmbedding.ts:68](../packages/providers/responses/src/OpenAIEmbedding.ts#L68) — image part rejected with `InvalidRequest`. **Fix:** `Unsupported(imageEmbedding)`. (WIP)
- [JinaEmbedding.ts:138](../packages/providers/jina/src/JinaEmbedding.ts#L138) — multi-part `content[]` rejected with `InvalidRequest`. **Fix:** `Unsupported(multiPartInput)`. (WIP)

URL-audio rejections stay on `InvalidRequest` (genuine §3.5).

### 14.3 Field-on-type, runtime-always-rejects → narrow the type

These should narrow the field out (§3.4). For modifiers on the §7
curated list, also pessimistically omit the marker from the Layer.

- [GeminiTranscriber.ts:48-65](../packages/providers/google/src/GeminiTranscriber.ts#L48-L65) — `wordTimestamps`, `diarization` rejected unconditionally. **Fix:** `Omit<...,"wordTimestamps"|"diarization">` on `GeminiTranscribeRequest`. Omit both markers from the Gemini Layer.
- [OpenAITranscriber.ts:94](../packages/providers/openai/src/OpenAITranscriber.ts#L94) — `diarization` rejected unconditionally. **Fix:** `Omit<...,"diarization">`. Omit `DiarizationGuarantee`. Per §5 (mixed-model), also omit `WordTimestampsGuarantee` from the OpenAI Layer pessimistically (whisper-1 only).

### 14.4 Per-model variance checks to remove

Per §2.3, don't maintain per-model tables. Pass through the
provider's error and translate.

- [OpenAITranscriber.ts:85](../packages/providers/openai/src/OpenAITranscriber.ts#L85) — `wordTimestamps && model !== "whisper-1"` check. **Fix:** remove; let OpenAI return its 400, translate to `Unsupported`.
- [LyriaGenerator.ts:257](../packages/providers/google/src/LyriaGenerator.ts#L257) — clip-model × wav format check. **Fix:** remove; translate provider response.

### 14.5 Bucket-2 fields silently dropped → warn-and-drop

Field is honored by some models, ignored by others; today the
ignore is silent. Add `Effect.logWarning` via `warnDropped`.

- [GeminiEmbedding.ts:29-30](../packages/providers/google/src/GeminiEmbedding.ts#L29) — `task` ignored on `gemini-embedding-2`.
- [OpenAIEmbedding.ts:27-31](../packages/providers/responses/src/OpenAIEmbedding.ts#L27) — `task` silently ignored on the generic surface.
- [OpenAISynthesizer.ts:30-31](../packages/providers/openai/src/OpenAISynthesizer.ts#L30) — `instructions` honored only by `gpt-4o-mini-tts`.
- **STT `prompt`** on providers with no biasing equivalent — currently silent across multiple adapters.
- **LLM `parallelToolCalls`** on providers that don't support it — when LLM phase lands.

### 14.6 Bucket 3 — keep silent (no change needed)

- [openai/codec.ts:93](../packages/providers/openai/src/codec.ts#L93) — caller's `sampleRate` ignored, realized format reported on the output. Provider has an interpretation (it picks a format); silent is correct.

### 14.7 Identity-typed inconsistency — the `task` field

Same field, three different mechanisms across embedding providers:

| Provider                  | Today                                  | Correct            |
| ------------------------- | -------------------------------------- | ------------------ |
| Jina                      | Narrows `task: JinaTask`               | §3.4 ✓             |
| OpenAIEmbedding (typed)   | Omits `task` entirely                  | §3.4 ✓             |
| OpenAIEmbedding (generic) | Accepts + silently drops               | should warn (14.5) |
| GeminiEmbedding (typed)   | Widens to `GoogleEmbeddingTask`        | §3.4 ✓             |
| GeminiEmbedding (runtime) | Drops silently on `gemini-embedding-2` | should warn (14.5) |

No structural fix — three providers, three valid type surfaces. Fix
is making the generic-Layer drops audible.

### 14.8 Provider-specific fields on the common shape — `DialogueTurn`

Already fixed in this branch. `styleDescription` and per-turn
`speed` were removed from
[SpeechSynthesizer.ts](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts)
in `Caps: Step 1` per the §3.4 principle. Re-add on Hume's typed
turn when Hume lands.

### 14.9 Tagged-union candidates

Not violations strictly. Both candidates use runtime predicates today;
convert if branching grows hairy.

- [LyriaGenerator.ts:93](../packages/providers/google/src/LyriaGenerator.ts#L93) — `isClipModel` predicate; candidate for `family: "clip" | "pro"`.
- Google Cloud TTS (not in tree).

### 14.10 Blanket stubs (informational, keep)

The stubbed `Unsupported` returns for methods covered by markers are
defensive duplicates. **Keep them.** Per §5, runtime guards are the
only safety for dynamic dispatch.

### 14.11 Per-modifier markers — Phase 1 scope

Phase 1 introduces only:

- `DiarizationGuarantee` and `WordTimestampsGuarantee` on Transcriber,
  with `requireDiarization` / `requireWordTimestamps` combinators.
- The `fallback` combinator (orElse stable; marker-intersection
  `@experimental`).

Future markers from §7 (ToolCalling, Vision, ImageEmbedding) wait
for their respective service-area phases and documented consumers.

### 14.12 Summary count

| Class                                                                                       | Count                      | Effort                  |
| ------------------------------------------------------------------------------------------- | -------------------------- | ----------------------- |
| Bucket 1 mis-classified as silent (14.1)                                                    | 2 sites                    | Mechanical              |
| `InvalidRequest` → `Unsupported` (14.2)                                                     | 2 sites                    | WIP                     |
| Field-on-type → narrow + marker omission (14.3)                                             | 2 providers                | WIP                     |
| Per-model checks to remove (14.4)                                                           | 2 sites                    | Mechanical              |
| Bucket 2 silent → warn (14.5)                                                               | 5+ sites                   | Add helper + call sites |
| Per-modifier markers Phase 1 (14.11)                                                        | 2 markers, `@experimental` | Moderate                |
| Core additions: `warnDropped` + `CapabilityWarning` (done — `capabilities/Capabilities.ts`) | —                          | Small                   |

---

## 15. Suggested adoption order

1. Land `warnDropped` helper + `CapabilityWarning` event in core.
   Unlocks §14.5. **Done** — lives in
   `packages/core/src/capabilities/Capabilities.ts` (also exports the
   `warnDroppedWhen` shorthand).
2. Promote 14.2 from WIP to merged.
3. Apply 14.3 — narrow `wordTimestamps` / `diarization` out of Gemini
   and OpenAI typed transcribers. WIP work.
4. Apply 14.4 — remove per-model variance checks; rely on
   provider-error translation.
5. Phase 1 per-modifier markers — `DiarizationGuarantee`,
   `WordTimestampsGuarantee` co-located in `Transcriber.ts` with
   `@experimental` JSDoc. Includes `fallback` combinator.
6. Apply 14.1 (pronunciation rejections).
7. Apply 14.5 (silent → warn) using the helper from step 1.
8. **Pause.** Gather usage signal from Phase 1 markers before
   adding more. Document any friction. Revisit §7 list and §6
   promotion criteria.
9. Add further markers from §7 (`ToolCallingGuarantee`,
   `VisionGuarantee`, `ImageEmbeddingGuarantee`) when their service
   areas reach the same maturity AND a documented consumer asks.

---

## Appendix A — NARROW vs GATE-ONLY (reference)

Reference for the rare case where you DO add a per-modifier marker
_and_ want it to narrow the result type. None of the §7 markers on
the current list does this; the appendix exists so the technique is
recorded in one place.

> **Narrow** the result field iff its presence is determined by
> (capability + request) alone — **not** by properties of the input
> data.

The pattern of NARROW cases: the field's value is a property of the
**request execution**, not the model's output. Seed echo, cache
token counts, schema-validated parse — computed at the boundary, not
emitted by the model freely.

The pattern of GATE-ONLY cases: even with the provider supporting the
capability and the caller requesting it, the field's presence can
still vary by input (single-speaker audio → no `speakerId`; empty
utterance → no `words[]`; model declines to think → no `reasoning`).

**Classification of modifiers historically considered:**

| Service       | Modifier                        | Verdict    | Reason                                               |
| ------------- | ------------------------------- | ---------- | ---------------------------------------------------- |
| Transcription | `diarization`                   | GATE-ONLY  | `speakerId` depends on multi-speaker audio           |
| Transcription | `wordTimestamps`                | GATE-ONLY  | `words[]` depends on audio content                   |
| Embeddings    | `task` tuning                   | GATE-ONLY  | Vector shape unchanged                               |
| LLM           | `thinking` / `reasoning_effort` | GATE-ONLY  | Model may decline to think                           |
| LLM           | `parallelToolCalls`             | GATE-ONLY  | `toolCalls[]` shape unchanged                        |
| **LLM**       | **`cacheControl`**              | **NARROW** | Cache token counts always reported when on           |
| **LLM**       | **`structured<T>`**             | **NARROW** | Schema validated server-side; conforming `parsed: T` |
| **Image gen** | **`seed`**                      | **NARROW** | Provider always echoes / generates a seed            |

**GATE-ONLY combinator (no cast):**

```ts
export const requireDiarization: {
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | DiarizationGuarantee>
  <A, E, R>(str: Stream.Stream<A, E, R>): Stream.Stream<A, E, R | DiarizationGuarantee>
} = ...
```

**NARROW combinator (single audited `as any`):**

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

The `as any` cast bridges what TS can't prove: that the marker in
`R` implies the runtime shape. Audited once at the combinator
definition.
