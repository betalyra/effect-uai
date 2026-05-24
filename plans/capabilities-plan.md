# Capabilities — Implementation Plan

Companion to [capabilities.md](capabilities.md) (the design) and
[experiments/capabilities-spike/index.ts](../experiments/capabilities-spike/index.ts)
(the type-level reference). This document is the concrete migration plan.

**Scope of this document:** STT (Transcriber) end-to-end, then TTS
(SpeechSynthesizer). Embeddings, LLM, and ImageGen are deferred to a
later plan once the STT/TTS rollout has shaken out the ergonomics.

---

## 0. Sequencing rationale

The consolidated guideline's §10 lists seven adoption steps. Of those,
the in-flight `refactor-capabilities` branch already covers parts of
steps 2 and 3 (the `Caps: Step 1` WIP commit). This plan picks up at
**step 4 — introduce the first per-modifier markers on Transcriber +
the `fallback` combinator** and carries it through to a clean,
type-safe STT surface before moving to TTS.

We start with STT because:

- The two modifiers we need (`diarization`, `wordTimestamps`) are the
  cleanest GATE-ONLY cases in the spike — no NARROW machinery, no `as
  any` casts.
- The provider gap is well understood: ElevenLabs and Inworld support
  both; OpenAI supports word timestamps for `whisper-1` only and no
  diarization; Gemini supports neither at the prompt-driven endpoint.
- The existing `SttStreaming` service-level marker gives us a
  pattern-mate already in tree
  ([Transcriber.ts:80](../packages/core/src/transcriber/Transcriber.ts#L80))
  — we mirror its declaration / registration / consumption shape.

TTS comes second because its per-modifier story is thinner (most TTS
flags are advisory and belong in row E "warn-and-drop") — most of the
remaining TTS work is §9.1 (promote pronunciation silent-drops to
`Unsupported`) rather than new markers.

---

## 1. Phase 1 — STT (Transcriber)

### 1.1 Core additions

All changes in `packages/core/src/transcriber/`. New file
`Capabilities.ts` keeps marker declarations and combinators together;
re-exported from `Transcriber.ts` for caller ergonomics.

#### 1.1.1 New marker declarations

```ts
// packages/core/src/transcriber/Capabilities.ts
import { Context, Effect, Stream } from "effect"

/**
 * GATE-ONLY marker — Layers that diarize ship this; consumers gate via
 * `requireDiarization`. Result `speakerId` stays optional because
 * single-speaker audio legitimately returns no speaker even on a
 * diarizing provider. See plans/capabilities.md §4.2.
 */
export class DiarizationGuarantee extends Context.Service<DiarizationGuarantee, void>()(
  "@betalyra/effect-uai/capability/DiarizationGuarantee",
) {}

export class WordTimestampsGuarantee extends Context.Service<WordTimestampsGuarantee, void>()(
  "@betalyra/effect-uai/capability/WordTimestampsGuarantee",
) {}
```

Tag string convention matches the existing
`@betalyra/effect-uai/capability/SttStreaming`
([Transcriber.ts:81](../packages/core/src/transcriber/Transcriber.ts#L81)).

#### 1.1.2 `requireX` combinators

Per spike §1 (GATE-ONLY shape, no result narrowing). Both Effect-
and Stream-friendly variants because `transcribe` returns an Effect
but `streamTranscriptionFrom` returns a Stream — the spike only
covers Effect.

```ts
export const requireDiarization: {
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | DiarizationGuarantee>
  <A, E, R>(str: Stream.Stream<A, E, R>): Stream.Stream<A, E, R | DiarizationGuarantee>
} = (input: any) =>
  Effect.isEffect(input)
    ? Effect.flatMap(DiarizationGuarantee.asEffect(), () => input)
    : Stream.unwrap(Effect.map(DiarizationGuarantee.asEffect(), () => input))

// same shape for requireWordTimestamps
```

**Decision needed:** dual Effect/Stream or two named exports
(`requireDiarization` / `requireDiarizationStream`)? The dual is
nicer at the call site; two exports are simpler to type. Leaning
dual — easy to reverse if it bites us.

#### 1.1.3 `fallback` combinator

The spike's machinery lives inside the `Transcription` namespace but
is mechanically service-agnostic — only the runtime impl is
service-specific (which method to chain with `Effect.orElse`).

Proposal: lift `IntersectROut` to `packages/core/src/internal/typeHelpers.ts`
(or similar; pick one — there's no existing utility module today).
Keep a `Transcriber.fallback` runtime wrapper that knows to orElse on
both `transcribe` and `streamTranscriptionFrom`.

```ts
// packages/core/src/transcriber/Capabilities.ts
export const fallback = <
  const Layers extends ReadonlyArray<Layer.Layer<Transcriber, any, any>>,
>(tiers: Layers): Layer.Layer<IntersectROut<Layers>, never, LayerRIn<Layers>> => {
  // Build a `Transcriber` whose transcribe / streamTranscriptionFrom
  // are `tiers.reduce((acc, t) => acc.pipe(Effect.orElse(...)))`.
  // Materialize each tier in its own scope via Layer.unwrapEffect.
  // ...
}
```

**Two TypeScript gotchas from the spike that must carry over:**

1. `<const Layers extends …>` — without `const`, array literals
   widen and `IntersectROut` returns `unknown`.
2. `infer _E, infer _RIn` (not `any, any`) in `ROutOf` — `Layer` is
   contravariant in `ROut`, so `any` in other slots collapses `infer`
   to `unknown`.

Both already documented in the spike header
([index.ts:496-503](../experiments/capabilities-spike/index.ts#L496)).
Copy the comments verbatim to the runtime file so future-us doesn't
re-learn them.

**Decision needed:** is `fallback` a Transcriber-only concern for
Phase 1, or do we factor a generic capability-fallback helper that
SpeechSynthesizer can reuse in Phase 2? Recommendation: build it on
Transcriber first, factor when SpeechSynthesizer needs it (don't
pre-generalize from one example).

#### 1.1.4 No changes to `TranscriptResult`, `WordTimestamp`, or
helpers

`speakerId` and `words[]` stay optional
([Transcript.ts:6,20](../packages/core/src/domain/Transcript.ts#L6))
— guideline §4.2 GATE-ONLY rule. The combinators only touch `R`.

### 1.2 Provider Layer updates — markers

Each provider's existing `Layer.mergeAll(...)` block gets one or two
new `Layer.succeed(Marker, undefined)` lines. **No runtime behaviour
changes.**

| Provider | File | DiarizationGuarantee | WordTimestampsGuarantee |
|---|---|---|---|
| **ElevenLabs** STT | [ElevenLabsTranscriber.ts:167-182](../packages/providers/elevenlabs/src/ElevenLabsTranscriber.ts#L167) | ✓ ship | ✓ ship |
| **Inworld** STT (sync) | [InworldTranscriber.ts:209-225](../packages/providers/inworld/src/InworldTranscriber.ts#L209) | ✓ ship | ✓ ship |
| **Inworld** STT (realtime) | [InworldRealtimeTranscriber.ts:49-64](../packages/providers/inworld/src/InworldRealtimeTranscriber.ts#L49) | ✓ ship | ✓ ship |
| **OpenAI** STT | [OpenAITranscriber.ts:267-285](../packages/providers/openai/src/OpenAITranscriber.ts#L267) | ✗ omit | **conditional — see §1.3.2** |
| **Gemini** STT | [GeminiTranscriber.ts:203-219](../packages/providers/google/src/GeminiTranscriber.ts#L203) | ✗ omit | ✗ omit |

OpenAI is the awkward one: `wordTimestamps` only works on `whisper-1`,
not on `gpt-4o-transcribe`. Per guideline §9.3, the right move is
either to split into `OpenAIWhisper1Layer` + `OpenAIGpt4oTranscribeLayer`
(each ships the marker iff it applies) or to keep one Layer that
**doesn't** ship the marker and force callers who need word timestamps
into the typed `OpenAIWhisper1Layer`. Recommendation below.

### 1.3 Per-provider request narrowing — §9.3 follow-through

The `Caps: Step 1` commit already started this. The remaining work:

#### 1.3.1 Gemini

[GeminiTranscriber.ts:30-35](../packages/providers/google/src/GeminiTranscriber.ts#L30)
already `Omit`s both `wordTimestamps` and `diarization` from the typed
request. **Already correct.** Once §1.1 lands, delete the runtime
guards at lines 62-78 — the per-modifier markers (which Gemini does
not ship) catch the misuse at compile time for callers using the
generic Layer.

**Caveat:** the runtime guard still has value for **dynamic** provider
selection (a `selectByModel` value-level chooser strips markers from
the type). Keep both — narrow at type level, guard at runtime as
defense in depth. Add a comment pointing at this plan so the
defensive guard isn't deleted later as "dead code."

#### 1.3.2 OpenAI

[OpenAITranscriber.ts:33-40](../packages/providers/openai/src/OpenAITranscriber.ts#L33)
already `Omit`s `diarization` and keeps `wordTimestamps`. Two choices:

**Option A (recommended): split into model-family Layers.**
- `OpenAIWhisper1Layer` — narrows `model` to `"whisper-1"`, keeps
  `wordTimestamps`, ships `WordTimestampsGuarantee`.
- `OpenAIGpt4oTranscribeLayer` — narrows `model` to gpt-4o variants,
  `Omit`s `wordTimestamps`, ships nothing.
- The current `OpenAITranscriber` Layer becomes a thin re-export that
  installs whichever family the caller wants.

**Option B (cheaper, less type-safe):** keep one Layer; don't ship
the marker. Callers who want word timestamps fall back to runtime
`Unsupported`.

Recommendation: Option A. It's a one-shot cost but it lets `fallback`
combinator users compose `OpenAIWhisper1Layer + ElevenLabsLayer` and
get `WordTimestampsGuarantee` surviving the intersection.

**Sub-decision:** do we split provider Layers in this Phase 1 plan or
defer to a follow-up? Splitting is mechanical but touches the public
re-exports. Recommend deferring — Phase 1 lands with Option B, Phase
1.5 splits OpenAI.

### 1.4 Mock layers + tests

#### 1.4.1 MockTranscriber

[MockTranscriber.ts:83-137](../packages/core/src/testing/MockTranscriber.ts#L83)
already has `layer` (ships `SttStreaming`) and `layerSyncOnly` (omits
`SttStreaming`). Mirror the same pattern for the new markers:

- `layer(script)` — ships `SttStreaming + DiarizationGuarantee +
  WordTimestampsGuarantee`. The "full capability" mock.
- `layerWithoutDiarization(script)` — omits `DiarizationGuarantee`.
- `layerWithoutWordTimestamps(script)` — omits `WordTimestampsGuarantee`.
- Existing `layerSyncOnly` stays as-is (its consumers care about
  `SttStreaming`, not the per-modifier markers — recommend it ship
  both new markers too so existing tests don't break).

#### 1.4.2 New tests

In [Transcriber.test.ts](../packages/core/src/transcriber/Transcriber.test.ts):
mirror the existing `SttStreaming` type-test block (lines 42-88) for
each new marker pair.

- ✓ `requireDiarization` on `transcribe(...)` against
  `MockTranscriber.layer` typechecks and resolves to `never` R.
- ✗ Same against `layerWithoutDiarization` leaks the marker — use
  `@ts-expect-error` on `Effect.runPromise`.
- ✓ `fallback([elevenlabsMock, inworldMock])` exposes both markers.
- ✗ `fallback([elevenlabsMock, openaiMock])` exposes only
  `WordTimestampsGuarantee`; consuming with `requireDiarization`
  leaks.

These are pure typecheck tests — vitest `expectTypeOf` (per [memory:
no scratch type-check files][1]), not throwaway `_check-*.ts`.

[1]: ../.claude/projects/-Users-janschulte-code-effect-uai/memory/feedback_no_scratch_type_checks.md

#### 1.4.3 Runtime smoke for `fallback`

A small integration-test that exercises the orElse chain:
- Tier 1 returns `Unsupported`; tier 2 returns a value → fallback
  returns the tier-2 value.
- All tiers return `Unsupported` → fallback surfaces the last error.
- Stream case: tier 1 errors at acquire; tier 2 streams successfully.

### 1.5 Recipes / docs

Add one minimal recipe under `recipes/` showing:

```ts
import { Transcriber } from "@effect-uai/core"
import { ElevenLabsTranscriber } from "@effect-uai/elevenlabs"
import { OpenAITranscriber } from "@effect-uai/openai"

const layer = Transcriber.fallback([ElevenLabsTranscriber.layer, OpenAITranscriber.layer])

const program = Effect.gen(function* () {
  const r = yield* Transcriber.transcribe({ audio, diarization: true })
    .pipe(Transcriber.requireDiarization)
  return r
}).pipe(Effect.provide(layer))
```

Recipe runner naming follows the established pattern: `run-node.ts`
([memory][2]).

[2]: ../.claude/projects/-Users-janschulte-code-effect-uai/memory/feedback_runner_naming.md

### 1.6 Phase 1 deliverable checklist

- [ ] `packages/core/src/transcriber/Capabilities.ts` with two
      markers, two `requireX` combinators, `fallback`.
- [ ] Re-exports from
      `packages/core/src/transcriber/Transcriber.ts` (no breaking
      change to existing surface).
- [ ] Layer registrations in ElevenLabs, Inworld (sync + realtime),
      OpenAI (deferred to Phase 1.5), Gemini.
- [ ] MockTranscriber `layer` / `layerWithoutDiarization` /
      `layerWithoutWordTimestamps`.
- [ ] `expectTypeOf` blocks for each marker in `Transcriber.test.ts`.
- [ ] Runtime smoke for `fallback` (3 cases above).
- [ ] One recipe under `recipes/transcribe-fallback/` with
      `run-node.ts`.
- [ ] No changes to `TranscriptResult` / `WordTimestamp` shapes.

---

## 2. Phase 2 — TTS (SpeechSynthesizer)

Smaller than Phase 1. The two service-level markers
(`TtsIncrementalText`, `MultiSpeakerTts`) already exist
([SpeechSynthesizer.ts:162,180](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L162))
and providers already ship/omit them correctly. The work here is:

1. **Add a `fallback` combinator for TTS** (parallel to §1.1.3).
2. **Promote silent pronunciation drops to `Unsupported`** — guideline
   §9.1.
3. **Decide whether any TTS modifiers warrant per-modifier markers.**

### 2.1 Fallback for SpeechSynthesizer

Mechanical: lift the `IntersectROut` type helper (factored out in
§1.1.3) into a shared location, then write
`SpeechSynthesizer.fallback` that orElses across all five service
methods. Carries existing service-level markers
(`TtsIncrementalText`, `MultiSpeakerTts`) through the intersection
correctly.

### 2.2 §9.1 — pronunciation drops

| Provider | File | Current behaviour | Fix |
|---|---|---|---|
| **Inworld** TTS | [InworldSynthesizer.ts:78-95](../packages/providers/inworld/src/InworldSynthesizer.ts#L78) | non-IPA entries silently skipped | reject with `AiError.Unsupported` if any non-IPA entry present |
| **ElevenLabs** TTS | [ElevenLabsSynthesizer.ts:79-113](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79) | whole-array dropped on unsupported model; per-item x-sampa silently dropped | reject with `Unsupported` for both gaps |

`pronunciations` is row D not row E — the override is load-bearing
(guideline §4.3).

### 2.3 Per-modifier markers for TTS — discussion only

Looking at the TTS modifier surface against the §4.2 NARROW/GATE-ONLY
rule:

| Modifier | Row | Why |
|---|---|---|
| `pronunciations` | D (Unsupported) | load-bearing; not a marker case |
| `speed` | E (warn-and-drop) | clamp/ignore still produces valid audio |
| `languageCode` | E | hint; provider may ignore |
| `outputFormat` | D (existing) | provider can't fulfill the shape — already correct on Gemini |
| `instructions` (OpenAI) | E | gpt-4o-mini-tts only; silent today |

None of these is a per-modifier marker candidate. The marker pattern
fits **on/off capabilities the caller can require** — TTS's optional
fields are mostly "hints that may be ignored" (row E) or "data-driven
gaps" (row D), not on/off configuration gates.

**Recommendation:** **no new TTS markers in Phase 2.** The marker
discussion can revisit when we add provider-specific knobs (e.g. SSML
support could become a `SsmlGuarantee` marker if/when we surface a
common SSML field).

### 2.4 Phase 2 deliverable checklist

- [ ] `SpeechSynthesizer.fallback` (using the lifted helper).
- [ ] Inworld pronunciation: silent drop → `Unsupported`.
- [ ] ElevenLabs pronunciation: two silent drops → `Unsupported`.
- [ ] Update `MockSpeechSynthesizer.layerWithoutIncremental`
      etc. if anything in §2.1 forces a shape change (don't expect
      so).
- [ ] Tests for fallback marker intersection.
- [ ] No changes to `SpeechSynthesizerService` shape.

---

## 3. Cross-cutting work (touches both phases)

### 3.1 `dropUnsupported` helper + `CapabilityWarning` event

Guideline §10 step 1. Lowest-disruption fix for the §1.3 silent-drop
problem. Not strictly required for Phase 1 (STT has no silent drops
that warrant it), but **prerequisite for §9.4** which Phase 2's
pronunciation work will surface.

Sketch:

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

// packages/core/src/capabilities/dropUnsupported.ts
export const dropUnsupported = (
  warning: Omit<CapabilityWarning, "_tag">,
): Effect.Effect<void> =>
  Effect.logWarning("Capability dropped", { ...warning, _tag: "CapabilityWarning" })
```

**Decision needed:** does `CapabilityWarning` become an `AiError`
variant (typed channel, caller pattern-matches) or stay on the log
side (observability only)? Guideline open question §6 leaves this
undecided. **Recommend:** start log-side (cheaper, no API surface
change). Promote to typed error if a real consumer needs to react.

### 3.2 Provider registration audit

After Phase 1+2 land, sweep every provider Layer and confirm:

- Every supported per-modifier capability has its marker registered.
- Every unsupported capability is **either** narrowed out of the
  typed request **or** runtime-guarded **or** both (defense in depth
  for dynamic selection).

Track in a follow-up checklist commit; don't gate the phases on it.

---

## 4. Decisions to make before coding

These need answers before Phase 1 implementation starts. None
blocks writing the plan, but each forks the implementation.

1. **Dual Effect/Stream `requireX` vs two named exports?**
   Recommendation: dual.
2. **`fallback` location — `transcriber/Capabilities.ts` or shared
   `internal/`?** Recommendation: keep runtime in transcriber for
   Phase 1; lift type helper to `internal/typeHelpers.ts` so Phase 2
   can reuse without copy-paste.
3. **OpenAI STT — split into Whisper1 / Gpt4o Layers now or later?**
   Recommendation: later (Phase 1.5). Phase 1 ships OpenAI without
   `WordTimestampsGuarantee`.
4. **`CapabilityWarning` — typed error or log only?**
   Recommendation: log only for now.
5. **Tag string convention for the new markers** — confirmed
   `@betalyra/effect-uai/capability/<Name>` per existing
   `SttStreaming`. No decision needed, just locking it in.

---

## 5. Open questions (carry over from guideline §6)

- **Third-party Layer authors:** no enforcement that "if you
  implement diarization, you must register the marker." Forgotten
  markers leave consumers stuck on the lax path. Not blocking Phase
  1; raise as a doc/lint item.
- **Inter-package wire boundaries:** marker types don't survive JSON
  serialization. Phase 1 doesn't introduce this problem (markers are
  layer-side, not value-side) but worth a mention in the recipe doc.
- **`MultiSpeakerTts` granularity:** today it gates both
  `synthesizeDialogue` and `streamSynthesizeDialogue`. If a provider
  supports one but not the other we'd need to split — not on our
  roadmap.

---

## 6. Out of scope — future phases

- **Phase 3 — Embeddings.** Smaller surface; just `TaskTuningGuarantee`
  (GATE-ONLY) per spike §2. Also catches up the warn-and-drop work
  from guideline §9.4.
- **Phase 4 — LLM.** This is where the NARROW machinery actually
  earns its keep (`CacheControlGuarantee`, `StructuredOutputGuarantee`
  with `as any`-audited combinators). Bigger phase; needs its own
  plan.
- **Phase 5 — Image generation.** `SeedGuarantee` (NARROW) per spike
  §4. Small.

---

## 7. Estimated effort (rough)

| Phase | Surface touched | Effort |
|---|---|---|
| Phase 1 (STT) | 1 core file added, ~5 provider Layer blocks, mock + tests, 1 recipe | 1-2 days |
| Phase 1.5 (OpenAI split) | 1 provider package re-org | 0.5 day |
| Phase 2 (TTS) | 1 core function, 2 provider files (pronunciation), tests | 0.5-1 day |
| Cross-cutting (§3.1) | 2 small new core files | 0.5 day |
| Phases 3-5 (separate plans) | — | — |
