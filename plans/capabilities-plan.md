# Capabilities — Implementation Plan

Companion to [capabilities.md](capabilities.md) (the design) and
[experiments/capabilities-spike/index.ts](../experiments/capabilities-spike/index.ts)
(the type-level reference). This document is the concrete migration plan.

**Scope:** Phase 0 prerequisites, then STT (Transcriber) end-to-end,
then TTS (SpeechSynthesizer). Embeddings, LLM, and ImageGen are
deferred to a later plan once STT/TTS rollout has shaken out the
ergonomics.

---

## 0. Scope & sequencing

Three phases:

- **Phase 0 — Prerequisites.** `dropUnsupported` helper +
  `CapabilityWarning` event; lock in the "translate provider errors,
  don't maintain per-model tables" policy (guideline §2.3).
- **Phase 1 — STT.** Per-modifier markers + `fallback` combinator on
  Transcriber. Remove per-model variance checks. Promote silent
  bucket-2 drops to `dropUnsupported`.
- **Phase 2 — TTS.** `fallback` combinator on SpeechSynthesizer.
  Promote silent pronunciation drops to `Unsupported`. No new
  per-modifier markers.

We start with STT because:

- `diarization` and `wordTimestamps` are the cleanest GATE-ONLY
  cases — no result-type changes, no `as any` casts.
- The provider gap is well understood: ElevenLabs and Inworld
  support both; OpenAI supports word timestamps for `whisper-1` only
  and no diarization; Gemini supports neither.
- The existing `SttStreaming` service-level marker gives us a
  pattern-mate in tree
  ([Transcriber.ts:80](../packages/core/src/transcriber/Transcriber.ts#L80))
  — we mirror its declaration / registration / consumption shape.

TTS comes second because its per-modifier story is thinner — most
TTS modifiers are bucket 2 (warn-and-drop) or bucket 3 (silent), not
marker candidates. Phase 2 is mostly the pronunciation fix.

---

## 1. Phase 0 — Prerequisites

Unblocks Phase 1's STT-prompt warn-and-drop AND Phase 2's
pronunciation rejection logging. Small, mechanical, lands first.

### 1.1 `CapabilityWarning` event

```ts
// packages/core/src/domain/CapabilityWarning.ts
export type CapabilityWarning = {
  readonly _tag: "CapabilityWarning"
  readonly provider: string
  readonly capability: string
  readonly field: string
  readonly value: unknown
  readonly reason: string
}
```

Log-only for now (no API surface). Promote to typed `AiError`
variant only if a consumer needs to pattern-match — tracked as open
item in guideline §11.

### 1.2 `dropUnsupported` helper

```ts
// packages/core/src/capabilities/dropUnsupported.ts
export const dropUnsupported = (
  warning: Omit<CapabilityWarning, "_tag">,
): Effect.Effect<void> =>
  Effect.logWarning("Capability dropped", { ...warning, _tag: "CapabilityWarning" })
```

That's the whole API. Used by adapters at the point where they drop
a bucket-2 field.

### 1.3 Provider error translation policy — locked in

Guideline §2.3: per-Layer gaps stay as proactive guards; per-model
gaps **translate the provider's error**. Phase 1 will exercise this
by removing OpenAI's `wordTimestamps && model !== "whisper-1"` check.

No new infrastructure needed — existing `AiError.Unsupported`
covers the translated case. The work is in each adapter's existing
error-translation layer (already extracts `error` from non-2xx
responses).

### 1.4 Phase 0 deliverables

- [ ] `packages/core/src/domain/CapabilityWarning.ts`
- [ ] `packages/core/src/capabilities/dropUnsupported.ts`
- [ ] Re-exports from `packages/core/src/index.ts`
- [ ] Smoke test that `dropUnsupported(...)` emits the structured log entry
- [ ] No changes to any provider yet — that's Phase 1 / Phase 2

---

## 2. Phase 1 — STT (Transcriber)

### 2.1 Core additions

All changes in
[packages/core/src/transcriber/Transcriber.ts](../packages/core/src/transcriber/Transcriber.ts) —
**co-located** with the existing `Transcriber` and `SttStreaming`
declarations, NOT in a separate `Capabilities.ts` and NOT in a
separate experimental sub-path. Markers and combinators are
load-bearing for provider packages; a separate sub-path would force
provider packages to import from "experimental" (guideline §6).

#### 2.1.1 Marker declarations

```ts
// packages/core/src/transcriber/Transcriber.ts (additions)

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
export class DiarizationGuarantee extends Context.Service<DiarizationGuarantee, void>()(
  "@betalyra/effect-uai/capability/DiarizationGuarantee",
) {}

/**
 * @experimental See `DiarizationGuarantee` above.
 */
export class WordTimestampsGuarantee extends Context.Service<WordTimestampsGuarantee, void>()(
  "@betalyra/effect-uai/capability/WordTimestampsGuarantee",
) {}
```

Tag string convention matches the existing
`@betalyra/effect-uai/capability/SttStreaming`
([Transcriber.ts:81](../packages/core/src/transcriber/Transcriber.ts#L81)).

#### 2.1.2 `requireX` combinators — dual Effect/Stream overload

Overload pattern (Option A from the discussion) because both
`transcribe` returns Effect and `streamTranscriptionFrom` returns
Stream:

```ts
/**
 * @experimental Pipe through to require the Layer in scope ships
 * `DiarizationGuarantee`. Compile-time gate only; result fields
 * remain optional (single-speaker audio legitimately returns no
 * speakerId even on a diarizing provider).
 */
export const requireDiarization: {
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | DiarizationGuarantee>
  <A, E, R>(str: Stream.Stream<A, E, R>): Stream.Stream<A, E, R | DiarizationGuarantee>
} = (<A, E, R>(input: Effect.Effect<A, E, R> | Stream.Stream<A, E, R>) =>
  Effect.isEffect(input)
    ? Effect.flatMap(DiarizationGuarantee.asEffect(), () => input)
    : Stream.unwrap(Effect.map(DiarizationGuarantee.asEffect(), () => input))) as any

// same shape for requireWordTimestamps
```

Single `as any` at the implementation boundary; audited once. The
two overload signatures are public; the body type is `(input: any)
=> any` effectively.

#### 2.1.3 `fallback` combinator

Service-specific runtime (which methods to chain with `orElse`),
generic type machinery. For Phase 1 the type helper
(`IntersectROut` + `ROutOf`) lives inline in `Transcriber.ts` —
**lift to a shared module only when Phase 2 needs it**, not
speculatively.

```ts
type ROutOf<L> = L extends Layer.Layer<infer Out, infer _E, infer _RIn> ? Out : never

type IntersectROut<Layers extends ReadonlyArray<Layer.Layer<any, any, any>>> =
  Layers extends readonly [
    infer Head extends Layer.Layer<any, any, any>,
    ...infer Tail extends ReadonlyArray<Layer.Layer<any, any, any>>,
  ]
    ? ROutOf<Head> & IntersectROut<Tail>
    : unknown

/**
 * Run provider tiers in preference order. First tier whose call
 * succeeds wins; on `AiError.Unsupported` from a tier, fall through
 * to the next.
 *
 * @experimental The marker-survives-intersection guarantee is
 * experimental. The orElse runtime behaviour is stable.
 */
export const fallback = <
  const Layers extends ReadonlyArray<Layer.Layer<Transcriber, any, any>>,
>(tiers: Layers): Layer.Layer<IntersectROut<Layers>, never, /* RIn union */> => {
  // Runtime: build a Transcriber whose `transcribe` and
  // `streamTranscriptionFrom` are `tiers.reduce(orElse)`. Each tier
  // materialised in its own scope via Layer.unwrapEffect.
  ...
}
```

**Two TypeScript gotchas — copy verbatim from the spike** into a
comment block above the type helpers:

1. `<const Layers extends …>` — without `const`, array literals
   widen to non-tuple unions and `IntersectROut` returns `unknown`.
2. `infer _E, infer _RIn` (not `any, any`) in `ROutOf` — `Layer` is
   contravariant in `ROut`; `any` in other slots collapses `infer
   Out` to `unknown`.

Reference: [experiments/capabilities-spike/index.ts:130-152](../experiments/capabilities-spike/index.ts#L130).

#### 2.1.4 No result type changes

`TranscriptResult` and `WordTimestamp` stay exactly as they are
today
([Transcript.ts:6,20](../packages/core/src/domain/Transcript.ts#L6)).
GATE-ONLY markers don't touch result types. `speakerId` and `words`
remain optional.

This is the entire `domain/Transcript.ts` change for Phase 1: **none.**

### 2.2 Provider Layer updates — marker registration

Each provider's existing `Layer.mergeAll(...)` gets zero, one, or
two new `Layer.succeed(Marker, undefined)` lines. **Pessimistic
registration** per guideline §5: ship a marker only if every model
the Layer routes to honors the modifier.

| Provider | File | DiarizationGuarantee | WordTimestampsGuarantee |
|---|---|---|---|
| **ElevenLabs** STT | [ElevenLabsTranscriber.ts:167-182](../packages/providers/elevenlabs/src/ElevenLabsTranscriber.ts#L167) | ✓ ship | ✓ ship |
| **Inworld** STT (sync) | [InworldTranscriber.ts:209-225](../packages/providers/inworld/src/InworldTranscriber.ts#L209) | ✓ ship | ✓ ship |
| **Inworld** STT (realtime) | [InworldRealtimeTranscriber.ts:49-64](../packages/providers/inworld/src/InworldRealtimeTranscriber.ts#L49) | ✓ ship | ✓ ship |
| **OpenAI** STT | [OpenAITranscriber.ts:267-285](../packages/providers/openai/src/OpenAITranscriber.ts#L267) | ✗ omit | ✗ omit (pessimistic — whisper-1 only) |
| **Gemini** STT | [GeminiTranscriber.ts:203-219](../packages/providers/google/src/GeminiTranscriber.ts#L203) | ✗ omit | ✗ omit |

OpenAI ships **neither** marker. Per guideline §5 (mixed-model
Layers), the per-Layer marker only ships if every routable model
supports the modifier; whisper-1's exception doesn't qualify. A
`withModel<M>()` Layer constructor that narrows the marker set to a
specific model's profile is the escape hatch — introduce lazily,
when a consumer asks. **Not in Phase 1.**

Callers needing the strict path for word timestamps use
`Transcriber.fallback([ElevenLabsTranscriber.layer,
OpenAITranscriber.layer])` — ElevenLabs satisfies the marker via
the intersection, OpenAI is best-effort fallback.

### 2.3 Per-provider request narrowing follow-through

The `Caps: Step 1` WIP commit started this. Remaining work:

#### 2.3.1 Gemini

[GeminiTranscriber.ts:30-35](../packages/providers/google/src/GeminiTranscriber.ts#L30)
already `Omit`s `wordTimestamps` and `diarization` from the typed
request. **Already correct.** Keep the runtime guards at
[GeminiTranscriber.ts:62-78](../packages/providers/google/src/GeminiTranscriber.ts#L62)
as defense-in-depth for dynamic provider selection (guideline §5).
Add a comment pointing at the guideline so the guards aren't deleted
later as "dead code."

#### 2.3.2 OpenAI

[OpenAITranscriber.ts:33-40](../packages/providers/openai/src/OpenAITranscriber.ts#L33)
already `Omit`s `diarization`. **Keep `wordTimestamps` on the typed
request** — it works for `whisper-1`. Per §2.4 below, drop the
per-model runtime check.

### 2.4 Remove per-model variance checks (guideline §2.3)

Guideline §2.3 — don't maintain per-model capability tables.
Translate provider errors instead. Removals:

- [OpenAITranscriber.ts:85](../packages/providers/openai/src/OpenAITranscriber.ts#L85) —
  drop `if (req.wordTimestamps && req.model !== "whisper-1") throw
  Unsupported`. Let OpenAI return its 400, translate to
  `AiError.Unsupported` in the error-translation layer.
- Audit OpenAI adapter's existing error-translation: ensure
  `error.type === "invalid_request_error"` with capability-shaped
  messages produces `Unsupported`, not `InvalidRequest`.

This is the *first concrete application* of the §2.3 policy. The
guideline §14.4 lists this and `LyriaGenerator` clip × wav as the
known per-model checks to remove; Lyria is out of scope for Phase 1
(image/music; revisit in its own phase).

### 2.5 STT `prompt` → warn-and-drop

Guideline §14.5 — STT `prompt` is currently silent on providers
without a biasing equivalent. Now bucket 2 (explicit feature,
provider has no interpretation) per §2.

Per-provider audit:

| Provider | Has biasing equivalent? | Action |
|---|---|---|
| OpenAI Whisper | Yes (`prompt` field) | No change |
| AssemblyAI | Partial (`word_boost`) | No change if mapped; warn if not |
| ElevenLabs | No native equivalent | `dropUnsupported({field: "prompt", ...})` when caller provides it |
| Inworld | Has `prompts` array | No change |
| Gemini | Built into prompt template | No change |

Net work: one `dropUnsupported` call in `ElevenLabsTranscriber` (and
any other adapter that lacks a biasing equivalent — quick audit
during implementation).

### 2.6 Mocks + tests

#### 2.6.1 MockTranscriber

[MockTranscriber.ts:83-137](../packages/core/src/testing/MockTranscriber.ts#L83)
already has `layer` (ships `SttStreaming`) and `layerSyncOnly`
(omits `SttStreaming`). Mirror for the new markers:

- `layer(script)` — ships `SttStreaming + DiarizationGuarantee +
  WordTimestampsGuarantee`. The "full capability" mock.
- `layerWithoutDiarization(script)` — omits `DiarizationGuarantee`.
- `layerWithoutWordTimestamps(script)` — omits
  `WordTimestampsGuarantee`.
- `layerSyncOnly` — extend to ship both new markers (it's about
  streaming, not per-modifier; existing tests shouldn't break).

#### 2.6.2 Type-level tests in `Transcriber.test.ts`

Mirror the existing `SttStreaming` block at
[Transcriber.test.ts:42-88](../packages/core/src/transcriber/Transcriber.test.ts#L42)
for each marker pair. Use vitest `expectTypeOf` per memory.

- ✓ `requireDiarization` on `transcribe(...)` against
  `MockTranscriber.layer` typechecks and resolves to `never` R.
- ✗ Same against `layerWithoutDiarization` leaks the marker — use
  `@ts-expect-error` on `Effect.runPromise`.
- ✓ `fallback([elevenlabsMock, inworldMock])` exposes both markers.
- ✗ `fallback([elevenlabsMock, openaiMock])` exposes **nothing**
  (OpenAI ships neither marker, intersection drops both).
- ✓ Stream variant: piping `requireDiarization` after
  `streamTranscriptionFrom` preserves R + marker through the
  Stream chain.

#### 2.6.3 Runtime smoke for `fallback`

Small integration test exercising the orElse chain:

- Tier 1 returns `Unsupported`; tier 2 returns a value → fallback
  returns tier-2 value.
- All tiers return `Unsupported` → fallback surfaces the last error.
- Stream case: tier 1 errors at acquire; tier 2 streams successfully.

#### 2.6.4 Smoke for per-model translation

After the §2.4 removal, add a test that calls OpenAI's
transcriber-mock with `wordTimestamps: true` + non-whisper-1 model
and asserts the surfaced error is `Unsupported`, not the raw
provider error.

### 2.7 Recipe

Add one minimal recipe under
`recipes/transcribe-fallback/run-node.ts`:

```ts
import { Effect, Layer } from "effect"
import { Transcriber } from "@effect-uai/core"
import { ElevenLabsTranscriber } from "@effect-uai/elevenlabs"
import { OpenAITranscriber } from "@effect-uai/openai"

const layer = Transcriber.fallback([
  ElevenLabsTranscriber.layer,
  OpenAITranscriber.layer,
])

const program = Effect.gen(function* () {
  const r = yield* Transcriber.transcribe({ audio, diarization: true })
    .pipe(Transcriber.requireDiarization)
  return r
}).pipe(Effect.provide(layer))
```

Recipe runner naming follows the established pattern: `run-node.ts`
per memory.

### 2.8 Phase 1 deliverable checklist

- [ ] Markers + combinators added inline in
      [Transcriber.ts](../packages/core/src/transcriber/Transcriber.ts)
      with `@experimental` JSDoc.
- [ ] `fallback` combinator with both gotcha comments verbatim from
      the spike.
- [ ] Layer registrations: ElevenLabs ✓✓, Inworld sync ✓✓, Inworld
      realtime ✓✓, OpenAI ✗✗, Gemini ✗✗.
- [ ] OpenAI per-model `wordTimestamps` runtime check removed;
      provider error translation verified.
- [ ] ElevenLabs (and any other) STT `prompt` →
      `dropUnsupported` when no biasing equivalent.
- [ ] Gemini transcriber runtime guards retained as
      defense-in-depth, comment added.
- [ ] MockTranscriber: `layer` ships both markers,
      `layerWithoutDiarization`, `layerWithoutWordTimestamps` added.
- [ ] `expectTypeOf` blocks for each marker pair in
      `Transcriber.test.ts` (positive + negative cases for
      `requireX` and `fallback`).
- [ ] Runtime smoke for `fallback` (3 cases) and per-model
      translation (1 case).
- [ ] Recipe at `recipes/transcribe-fallback/run-node.ts`.
- [ ] No changes to
      [domain/Transcript.ts](../packages/core/src/domain/Transcript.ts).

---

## 3. Phase 2 — TTS (SpeechSynthesizer)

Smaller than Phase 1. The two service-level markers
(`TtsIncrementalText`, `MultiSpeakerTts`) already exist
([SpeechSynthesizer.ts:162,180](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L162))
and providers already ship/omit them correctly.

### 3.1 `fallback` for SpeechSynthesizer

If Phase 1's `IntersectROut` was kept inline in `Transcriber.ts`,
**lift it now** to `packages/core/src/internal/typeHelpers.ts` (or
similar — there's no existing shared utilities module today; pick
the location during Phase 2 implementation). Both `Transcriber.ts`
and `SpeechSynthesizer.ts` import from there.

`SpeechSynthesizer.fallback` runtime orElses across all five
service methods (`synthesize`, `streamSynthesis`,
`streamSynthesisFrom`, `synthesizeDialogue`,
`streamSynthesizeDialogue`). Carries existing service-level
markers (`TtsIncrementalText`, `MultiSpeakerTts`) through the
intersection correctly — verify with type tests parallel to §2.6.2.

### 3.2 Pronunciation drops → `Unsupported` (bucket 1)

Per guideline §14.1. Pronunciations are load-bearing — silent drop
= audibly wrong output.

| Provider | File | Current | Fix |
|---|---|---|---|
| **Inworld** TTS | [InworldSynthesizer.ts:78-95](../packages/providers/inworld/src/InworldSynthesizer.ts#L78) | non-IPA silently skipped | reject with `AiError.Unsupported` if any non-IPA entry present |
| **ElevenLabs** TTS | [ElevenLabsSynthesizer.ts:79-113](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79) | whole-array drop on unsupported model; per-item x-sampa silent drop | reject with `Unsupported` for both gaps |

Error message convention: `AiError.Unsupported({ capability:
"pronunciations", reason: "Inworld TTS only supports IPA
pronunciation encoding; got 'cmu-arpabet'." })`.

### 3.3 Bucket 2 fixes — instructions

Per guideline §14.5:

- [OpenAISynthesizer.ts:30-31](../packages/providers/openai/src/OpenAISynthesizer.ts#L30) —
  `instructions` silently ignored on `tts-1` / `tts-1-hd`.
  **Fix:** `dropUnsupported` when caller provides `instructions`
  against a non-mini-tts model.

Per §2.3 of the guideline, this is per-model variance. Strictly we
should translate the provider's error. **But** OpenAI doesn't error
on `instructions` for non-mini-tts; it silently ignores. So the
adapter has to actively warn — there's no provider error to
translate. Keep the per-model check **specifically for the
warn-and-drop path**; the §2.3 rule applies to rejection-side
checks, not to warning-side ones.

Note: [openai/codec.ts:93](../packages/providers/openai/src/codec.ts#L93)
`sampleRate` ignored is bucket 3 (provider always reports realized
format on output — has an interpretation). **No change.**

### 3.4 No new per-modifier markers for TTS

TTS modifier surface against the §4 failure-vs-degradation rule:

| Modifier | Verdict |
|---|---|
| `pronunciations` | bucket 1 — `Unsupported` (§3.2 above); not a marker |
| `speed` | bucket 3 — silent (clamp) |
| `languageCode` | bucket 3 — silent (inferred from voice) |
| `instructions` (OpenAI) | bucket 2 — `dropUnsupported` (§3.3 above) |
| `outputFormat` | bucket 1 — already `Unsupported` on Gemini |

None of these is a marker candidate. No new markers in Phase 2.
Revisit when a TTS feature with a real compliance use case lands
(e.g. SSML support could become a future `SsmlGuarantee` marker).

### 3.5 Phase 2 deliverable checklist

- [ ] `IntersectROut` lifted to shared location.
- [ ] `SpeechSynthesizer.fallback` with marker-intersection tests.
- [ ] Inworld pronunciation: silent drop → `Unsupported`.
- [ ] ElevenLabs pronunciation: two silent drops → `Unsupported`.
- [ ] OpenAI `instructions`: silent → `dropUnsupported` on
      non-mini-tts models.
- [ ] Mocks (`MockSpeechSynthesizer`) unchanged — Phase 2 adds no
      new markers.
- [ ] Tests for fallback marker intersection over
      `TtsIncrementalText` and `MultiSpeakerTts`.
- [ ] No changes to `SpeechSynthesizerService` shape.

---

## 4. Decisions recap (previously open)

All resolved during the design discussion. Recording here so they
don't get re-litigated mid-implementation.

| Decision | Resolution | Reasoning |
|---|---|---|
| `requireX` shape | Overloaded function (Effect / Stream), single `as any` in body | Best hover output, best error messages, no inference traps. |
| Marker / combinator location | Co-located inline in service module (`Transcriber.ts`), `@experimental` JSDoc | Load-bearing for providers; separate sub-path makes the "experimental" label dishonest. |
| OpenAI STT layer split | **No split.** Ship neither marker pessimistically. | Mixed-model variance is per-model, not per-Layer; per §5 of the guideline, pessimistic registration. |
| `withModel<M>()` escape hatch | **Not in Phase 1.** Add lazily when a consumer asks. | Don't speculate. |
| `CapabilityWarning` shape | Log-only via `Effect.logWarning`, no typed `AiError` variant | Cheaper; promote only if consumer needs programmatic match. |
| Tag string convention | `@betalyra/effect-uai/capability/<Name>` | Matches existing `SttStreaming`. |
| Per-model variance checks (e.g. OpenAI `wordTimestamps`) | Remove; translate provider errors | Guideline §2.3 — don't maintain per-model tables. |
| Per-service tag naming | Per-service classes (`Transcriber.DiarizationGuarantee`); naturally satisfied for STT modifiers | Cross-service modality markers (LLM `AudioInput` etc.) become a real concern only in later phases. |
| `IntersectROut` location | Inline in `Transcriber.ts` for Phase 1; lift to shared utility in Phase 2 when TTS needs it | Don't pre-generalise from one example. |
| `fallback` runtime stability | The orElse runtime is stable; the marker-intersection guarantee is `@experimental` | Different stability axes; document accordingly. |

---

## 5. Open items (carry over from guideline §11)

- **Third-party Layer authors.** No enforcement that "if you
  implement diarization, you must register the marker." Forgotten
  markers leave consumers stuck on the lax path. Not blocking; raise
  as a doc/lint item.
- **Inter-package wire boundaries.** Marker types don't survive
  JSON serialization. Phase 1 doesn't introduce this problem
  (markers are Layer-side); mention in the recipe doc.
- **`MultiSpeakerTts` granularity.** Today it gates both
  `synthesizeDialogue` and `streamSynthesizeDialogue`. If a provider
  supports one but not the other we'd need to split. Not on the
  roadmap.
- **Promotion criteria from `@experimental`.** What signal warrants
  dropping the tag? Guideline §11 leaves this open.

---

## 6. Out of scope — future phases

- **Phase 3 — Embeddings.** `ImageEmbeddingGuarantee`
  (per modality) when image embedding providers + consumers
  materialise. Also catches up §14.5 task-field warn-and-drop work.
- **Phase 4 — LLM.** `ToolCallingGuarantee`, `VisionGuarantee`,
  later `AudioInputGuarantee` / `VideoInputGuarantee` as multimodal
  providers land. Bigger phase; needs its own plan. Will revisit the
  NARROW question (`cacheControl`, `structured<T>`) but current
  policy says **lax with typed `LLM.structured<T>()` helper**, no
  NARROW marker.
- **Phase 5 — Image generation.** Currently lax. `SeedGuarantee` is
  not on the curated list under current policy.
- **Phase 6 — Music generation.** `MusicInteractiveSession` already
  in tree; no per-modifier markers planned.
- **Future services (video, live, OCR, S2ST, reranker).** Markers
  listed in guideline §7 Tier 3. Land with their respective
  services.

---

## 7. Estimated effort (rough)

| Phase | Surface touched | Effort |
|---|---|---|
| Phase 0 | 2 small new core files, 1 smoke test | 0.5 day |
| Phase 1 (STT) | Inline additions to `Transcriber.ts`, ~5 provider Layer blocks, 1-2 runtime check removals, 1-2 `dropUnsupported` calls, mock + tests, 1 recipe | 1.5-2 days |
| Phase 2 (TTS) | 1 core function + type helper lift, 2 provider pronunciation fixes, 1 instructions fix, tests | 1 day |
| Phases 3-6 | Separate plans | — |
