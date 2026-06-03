# Capabilities — Implementation Plan

Companion to [capabilities.md](capabilities.md) (the design) and
[experiments/capabilities-spike/index.ts](../experiments/capabilities-spike/index.ts)
(the type-level reference). This document is the concrete migration
plan, written against the **current `capabilities-redesign` branch
state**.

**Starting baseline (verified):**

- `warnDropped` / `warnDroppedWhen` helpers + `CapabilityWarning` type
  now exist in `packages/core/src/capabilities/Capabilities.ts` (Phase 0
  landed with the MusicGenerator work). The original baseline had none.
- No per-modifier markers in `Transcriber.ts` (only the existing
  service-level `SttStreaming` at line 80).
- `GeminiTranscribeRequest` and `OpenAITranscribeRequest` do **not**
  `Omit` `wordTimestamps` / `diarization` from `CommonTranscribeRequest`.
  Runtime guards in
  [GeminiTranscriber.ts:48-65](../packages/providers/google/src/GeminiTranscriber.ts#L48)
  and
  [OpenAITranscriber.ts:83-101](../packages/providers/openai/src/OpenAITranscriber.ts#L83).
- `OpenAITranscriber.ts:83` still carries the `model !== "whisper-1"`
  per-model guard.
- `LyriaGenerator.ts:256` still carries the `isClipModel × wav` check.
- `OpenAIEmbedding.ts:68` and `JinaEmbedding.ts:138` still throw
  `InvalidRequest` for capability gaps.
- `DialogueTurn` in
  [SpeechSynthesizer.ts:83](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L83)
  still carries `styleDescription` (and per-turn `speed`).
- Service-level markers in tree: `SttStreaming`
  (Transcriber.ts:80), `TtsIncrementalText`
  (SpeechSynthesizer.ts:166), `MultiSpeakerTts`
  (SpeechSynthesizer.ts:179), `MusicInteractiveSession`
  (MusicGenerator.ts:68), `Sandbox*` family (Sandbox.ts:419+).
- v0.6 dialogue methods (`synthesizeDialogue`,
  `streamSynthesizeDialogue`) are in tree and already gated by
  `MultiSpeakerTts`; provider stubs at
  [OpenAISynthesizer.ts:179-198](../packages/providers/openai/src/OpenAISynthesizer.ts#L179),
  [InworldSynthesizer.ts:221-240](../packages/providers/inworld/src/InworldSynthesizer.ts#L221),
  [GeminiSynthesizer.ts:176-186](../packages/providers/google/src/GeminiSynthesizer.ts#L176).

**Scope:** Phase 0 prerequisites, Phase 1 mechanical narrowing,
Phase 2 STT markers end-to-end, Phase 3 TTS. Embeddings, LLM, and
ImageGen are deferred to a later plan once Phase 2/3 rollout has
shaken out the ergonomics.

This branch starts from zero capability work. There is no
`Caps: Step 1` to inherit; every change below is part of the plan.

---

## 0. Scope & sequencing

Four phases:

- **Phase 0 — Prerequisites (DONE).** `warnDropped` helper +
  `CapabilityWarning` event in core; lock in the §2.3
  policy ("translate provider errors, don't maintain per-model
  tables").
- **Phase 1 — Mechanical narrowing.** Three independent cleanups
  that don't need the marker mechanism: typed-request `Omit`s on
  Gemini and OpenAI transcribers; `DialogueTurn` provider-specific
  field cleanup; `InvalidRequest` → `Unsupported` migration on
  OpenAI / Jina embeddings. Lands first because every change is a
  rename / type tweak, no new core surface.
- **Phase 2 — STT per-modifier markers.** `DiarizationGuarantee`,
  `WordTimestampsGuarantee`, the `requireX` combinators, the
  `fallback` combinator. Promote silent bucket-2 drops to
  `warnDropped`. Remove per-model variance checks.
- **Phase 3 — TTS.** `fallback` combinator on SpeechSynthesizer.
  Promote silent pronunciation drops to `Unsupported`. No new
  per-modifier markers.

We sequence Phase 1 ahead of Phase 2 so the mechanical narrowing
doesn't get tangled up with the marker rollout. The two have no
ordering dependency at the code level (Phase 1 doesn't add
`Capabilities*` symbols), but landing Phase 1 first means Phase 2
PRs touch only the marker mechanism and provider Layer registrations.

We start STT markers (Phase 2) before TTS (Phase 3) because:

- `diarization` and `wordTimestamps` are the cleanest GATE-ONLY
  cases — no result-type changes, no `as any` casts.
- The provider gap is well understood: ElevenLabs and Inworld
  support both; OpenAI supports word timestamps for `whisper-1` only
  and no diarization; Gemini supports neither.
- The existing `SttStreaming` service-level marker
  ([Transcriber.ts:80](../packages/core/src/transcriber/Transcriber.ts#L80))
  gives us a pattern-mate in tree.

TTS comes last because its per-modifier story is thinner. Most TTS
modifiers are bucket 2 (warn-and-drop) or bucket 3 (silent), not
marker candidates. Phase 3 is mostly the pronunciation fix and a
single `fallback` combinator.

---

## 1. Phase 0 — Prerequisites

Unblocks Phase 2's STT-prompt warn-and-drop AND Phase 3's
pronunciation rejection logging. Small, mechanical, lands first.

**Status: DONE.** Landed alongside the MusicGenerator redesign. Both
the `CapabilityWarning` type and the helpers live in a single file,
`packages/core/src/capabilities/Capabilities.ts` (not the separate
`domain/CapabilityWarning.ts` + `capabilities/dropUnsupported.ts` this
plan originally sketched), and the helper is named `warnDropped` (not
`dropUnsupported`). There is also a `warnDroppedWhen` shorthand.

### 1.1 `CapabilityWarning` event

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
```

Log-only for now (no API surface). Promote to typed `AiError`
variant only if a consumer needs to pattern-match.

### 1.2 `warnDropped` helper

```ts
// packages/core/src/capabilities/Capabilities.ts
export const warnDropped = (warning: Omit<CapabilityWarning, "_tag">): Effect.Effect<void> =>
  Effect.logWarning("Capability dropped", { ...warning, _tag: "CapabilityWarning" })

// Shorthand: warn-and-drop when a specific field is set; the value
// is attached automatically.
export const warnDroppedWhen = <T>(
  value: T | undefined,
  warning: Omit<CapabilityWarning, "_tag" | "value">,
): Effect.Effect<void> => (value === undefined ? Effect.void : warnDropped({ ...warning, value }))
```

That's the whole API. Used by adapters at the point where they drop
a bucket-2 field.

### 1.3 Provider error translation policy — locked in

Guideline §2.3: per-Layer gaps stay as proactive guards; per-model
gaps **translate the provider's error**. Phase 2 will exercise this
by removing OpenAI's `wordTimestamps && model !== "whisper-1"` check.

No new infrastructure needed — existing `AiError.Unsupported`
covers the translated case. The work is in each adapter's existing
error-translation layer (already extracts `error` from non-2xx
responses).

### 1.4 Phase 0 deliverables

- [x] `packages/core/src/capabilities/Capabilities.ts` (holds both the
      `CapabilityWarning` type and the `warnDropped` / `warnDroppedWhen`
      helpers)
- [x] Re-exports from `packages/core/src/index.ts`
- [ ] Smoke test that `warnDropped(...)` emits the structured log entry
- [ ] No changes to any provider yet — that's Phase 2 / Phase 3

---

## 2. Phase 1 — Mechanical narrowing

Three independent, type-level cleanups. No new core surface, no
marker mechanism touched. Lands as one PR or three small PRs — each
is mechanical.

### 2.1 Typed-request `Omit`s on transcribers (§14.3)

The field-on-type-but-runtime-always-rejects shape (§3.2(d)) should
narrow the type instead.

#### 2.1.1 Gemini

[GeminiTranscriber.ts:23](../packages/providers/google/src/GeminiTranscriber.ts#L23):

```ts
// Before
export type GeminiTranscribeRequest = Omit<CommonTranscribeRequest, "model"> & { … }

// After
export type GeminiTranscribeRequest = Omit<
  CommonTranscribeRequest,
  "model" | "wordTimestamps" | "diarization"
> & { … }
```

Keep the runtime guards at
[GeminiTranscriber.ts:48-65](../packages/providers/google/src/GeminiTranscriber.ts#L48)
as defense-in-depth for dynamic provider selection (guideline §5).
Add a comment pointing at §5 so the guards aren't deleted later as
"dead code."

#### 2.1.2 OpenAI

[OpenAITranscriber.ts:30](../packages/providers/openai/src/OpenAITranscriber.ts#L30):

```ts
// Before
export type OpenAITranscribeRequest = Omit<CommonTranscribeRequest, "model"> & { … }

// After
export type OpenAITranscribeRequest = Omit<
  CommonTranscribeRequest,
  "model" | "diarization"
> & { … }
```

**Keep `wordTimestamps`** on the typed request — it works for
`whisper-1`. Section 3.2 below removes the per-model check from the
adapter body; the field stays.

### 2.2 `DialogueTurn` cleanup (§14.8)

Apply the deferred §3.4 (type narrowing) principle to per-turn
fields that only Hume's voice surface honors.

[SpeechSynthesizer.ts:83](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L83):

```ts
// Before
export type DialogueTurn = {
  readonly voiceId: string
  readonly text: string
  readonly styleDescription?: string
  readonly speed?: number
}

// After
export type DialogueTurn = {
  readonly voiceId: string
  readonly text: string
}
```

Re-add `styleDescription` and `speed` on Hume's typed dialogue turn
when the Hume provider lands. None of the current providers wire
either field through.

Verify no provider adapter reads `turn.styleDescription` or
`turn.speed` before removing; a quick grep across
`packages/providers/` should show zero hits.

### 2.3 `InvalidRequest` → `Unsupported` on embeddings (§14.2)

The wire can carry the shape; the provider just doesn't support
the feature. `InvalidRequest` is for wire-shape mismatches only
(§3.5).

#### 2.3.1 OpenAI embeddings

[OpenAIEmbedding.ts:68](../packages/providers/responses/src/OpenAIEmbedding.ts#L68):

```ts
// Before
return new AiError.InvalidRequest({ … })

// After
return new AiError.Unsupported({
  provider: "openai",
  capability: "imageEmbedding",
  reason: "OpenAI's embedding API accepts text inputs only; image parts are not supported. Use a multimodal embedding provider (Cohere v3, Google multimodal).",
  raw,
})
```

#### 2.3.2 Jina embeddings

[JinaEmbedding.ts:138](../packages/providers/jina/src/JinaEmbedding.ts#L138):

```ts
// Before
const multiPartContentRejected: AiError.AiError = new AiError.InvalidRequest({ … })

// After
const multiPartContentRejected: AiError.AiError = new AiError.Unsupported({
  provider: "jina",
  capability: "multiPartInput",
  reason: "Jina embeddings accept a single content part per input; multi-part content arrays are not supported.",
})
```

URL-audio rejections at
[JinaEmbedding.ts:293](../packages/providers/jina/src/JinaEmbedding.ts#L293)
and [JinaEmbedding.ts:374](../packages/providers/jina/src/JinaEmbedding.ts#L374)
stay on `InvalidRequest` (genuine §3.5 wire-shape mismatch).

### 2.4 Phase 1 deliverables

- [ ] `GeminiTranscribeRequest` omits `wordTimestamps`, `diarization`.
- [ ] `OpenAITranscribeRequest` omits `diarization`; keeps `wordTimestamps`.
- [ ] `DialogueTurn` drops `styleDescription`, `speed`.
- [ ] OpenAI image-embedding rejection: `InvalidRequest` → `Unsupported`.
- [ ] Jina multi-part rejection: `InvalidRequest` → `Unsupported`.
- [ ] Existing tests for the four sites updated to expect the new
      error tag (`Unsupported` instead of `InvalidRequest`) and the
      new request shapes.
- [ ] No core API surface changes.

---

## 3. Phase 2 — STT (Transcriber)

### 3.1 Core additions

All changes in
[packages/core/src/transcriber/Transcriber.ts](../packages/core/src/transcriber/Transcriber.ts) —
**co-located** with the existing `Transcriber` and `SttStreaming`
declarations, NOT in a separate `Capabilities.ts` and NOT in a
separate experimental sub-path. Markers and combinators are
load-bearing for provider packages; a separate sub-path would force
provider packages to import from "experimental" (guideline §6).

#### 3.1.1 Marker declarations

```ts
// packages/core/src/transcriber/Transcriber.ts (additions, near line 80)

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

#### 3.1.2 `requireX` combinators — dual Effect/Stream overload

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

#### 3.1.3 `fallback` combinator

Service-specific runtime (which methods to chain with `orElse`),
generic type machinery. For Phase 2 the type helper
(`IntersectROut` + `ROutOf`) lives inline in `Transcriber.ts` —
**lift to a shared module only when Phase 3 needs it**, not
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

#### 3.1.4 No result type changes

`TranscriptResult` and `WordTimestamp` stay exactly as they are
today
([Transcript.ts:6,20](../packages/core/src/domain/Transcript.ts#L6)).
GATE-ONLY markers don't touch result types. `speakerId` and `words`
remain optional.

This is the entire `domain/Transcript.ts` change for Phase 2: **none.**

### 3.2 Remove per-model variance checks (guideline §2.3)

Guideline §2.3 — don't maintain per-model capability tables.
Translate provider errors instead. Removals:

- [OpenAITranscriber.ts:83](../packages/providers/openai/src/OpenAITranscriber.ts#L83) —
  drop the `wantsVerboseJson(request) && request.model !== "whisper-1"`
  branch. Let OpenAI return its 400, translate to
  `AiError.Unsupported` in the error-translation layer.
- Audit OpenAI adapter's existing error-translation: ensure
  `error.type === "invalid_request_error"` with capability-shaped
  messages produces `Unsupported`, not `InvalidRequest`.
- [LyriaGenerator.ts:256](../packages/providers/google/src/LyriaGenerator.ts#L256) —
  same treatment for the `isClipModel × wav` check. Translate the
  provider response instead of preempting it.

Bundling Lyria with the OpenAI removal exercises the same
provider-error-translation path twice in one PR. If Lyria proves
noisy, split it out — but the pattern is identical.

### 3.3 Provider Layer updates — marker registration

Each provider's existing Layer construction gets zero, one, or two
new `Layer.succeed(Marker, undefined)` lines. **Pessimistic
registration** per guideline §5: ship a marker only if every model
the Layer routes to honors the modifier.

| Provider                   | File                                                                                                    | Construction                     | DiarizationGuarantee | WordTimestampsGuarantee               |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------- | ------------------------------------- |
| **ElevenLabs** STT         | [ElevenLabsTranscriber.ts:168](../packages/providers/elevenlabs/src/ElevenLabsTranscriber.ts#L168)      | `Layer.mergeAll`                 | ✓ ship               | ✓ ship                                |
| **Inworld** STT (sync)     | [InworldTranscriber.ts:212](../packages/providers/inworld/src/InworldTranscriber.ts#L212)               | `Layer.merge` → `Layer.mergeAll` | ✓ ship               | ✓ ship                                |
| **Inworld** STT (realtime) | [InworldRealtimeTranscriber.ts:50](../packages/providers/inworld/src/InworldRealtimeTranscriber.ts#L50) | `Layer.mergeAll`                 | ✓ ship               | ✓ ship                                |
| **OpenAI** STT             | [OpenAITranscriber.ts:249](../packages/providers/openai/src/OpenAITranscriber.ts#L249)                  | `Layer.merge` (stays)            | ✗ omit               | ✗ omit (pessimistic — whisper-1 only) |
| **Gemini** STT             | [GeminiTranscriber.ts:191](../packages/providers/google/src/GeminiTranscriber.ts#L191)                  | `Layer.merge` (stays)            | ✗ omit               | ✗ omit                                |

Inworld sync and Gemini / OpenAI currently use `Layer.merge`
(two-arg). Adding marker lines means promoting to `Layer.mergeAll`
on the providers that ship one or both markers (Inworld sync). The
zero-marker providers (Gemini, OpenAI) stay on `Layer.merge` — no
change needed.

OpenAI ships **neither** marker. Per guideline §5 (mixed-model
Layers), the per-Layer marker only ships if every routable model
supports the modifier; whisper-1's exception doesn't qualify. A
`withModel<M>()` Layer constructor that narrows the marker set to a
specific model's profile is the escape hatch — introduce lazily,
when a consumer asks. **Not in Phase 2.**

Callers needing the strict path for word timestamps use
`Transcriber.fallback([ElevenLabsTranscriber.layer,
OpenAITranscriber.layer])` — ElevenLabs satisfies the marker via
the intersection, OpenAI is best-effort fallback.

### 3.4 STT `prompt` → warn-and-drop

Guideline §14.5 — STT `prompt` is currently silent on providers
without a biasing equivalent. Now bucket 2 (explicit feature,
provider has no interpretation) per §2.

Per-provider audit:

| Provider       | Has biasing equivalent?    | Action                                                        |
| -------------- | -------------------------- | ------------------------------------------------------------- |
| OpenAI Whisper | Yes (`prompt` field)       | No change                                                     |
| AssemblyAI     | Partial (`word_boost`)     | No change if mapped; warn if not                              |
| ElevenLabs     | No native equivalent       | `warnDropped({field: "prompt", ...})` when caller provides it |
| Inworld        | Has `prompts` array        | No change                                                     |
| Gemini         | Built into prompt template | No change                                                     |

Net work: one `warnDropped` call in `ElevenLabsTranscriber` (and
any other adapter that lacks a biasing equivalent — quick audit
during implementation).

### 3.5 Mocks + tests

#### 3.5.1 MockTranscriber — note the default change

[MockTranscriber.ts:83-137](../packages/core/src/testing/MockTranscriber.ts#L83)
today ships `SttStreaming` via `layer` and omits it via
`layerSyncOnly`. The plan:

- `layer(script)` — **now ships `SttStreaming + DiarizationGuarantee +
WordTimestampsGuarantee`**. The "full capability" mock. This is a
  default change every existing transcriber test inherits; audit the
  callers to make sure no existing test relies on the absence of the
  new markers (none should — the markers are additive in `R`).
- `layerWithoutDiarization(script)` — omits `DiarizationGuarantee`.
- `layerWithoutWordTimestamps(script)` — omits
  `WordTimestampsGuarantee`.
- `layerSyncOnly` — extend to ship both new markers (it's about
  streaming, not per-modifier; existing tests shouldn't break).

Flag this in the PR description so reviewers know the mock surface
widened.

#### 3.5.2 Type-level tests in `Transcriber.test.ts`

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

#### 3.5.3 Runtime smoke for `fallback`

Small integration test exercising the orElse chain:

- Tier 1 returns `Unsupported`; tier 2 returns a value → fallback
  returns tier-2 value.
- All tiers return `Unsupported` → fallback surfaces the last error.
- Stream case: tier 1 errors at acquire; tier 2 streams successfully.

#### 3.5.4 Smoke for per-model translation

After the §3.2 removal, add a test that calls OpenAI's
transcriber-mock with `wordTimestamps: true` + non-whisper-1 model
and asserts the surfaced error is `Unsupported`, not the raw
provider error.

### 3.6 Recipe

Add one minimal recipe under
`recipes/transcribe-fallback/run-node.ts`:

```ts
import { Effect, Layer } from "effect"
import { Transcriber } from "@effect-uai/core"
import { ElevenLabsTranscriber } from "@effect-uai/elevenlabs"
import { OpenAITranscriber } from "@effect-uai/openai"

const layer = Transcriber.fallback([ElevenLabsTranscriber.layer, OpenAITranscriber.layer])

const program = Effect.gen(function* () {
  const r = yield* Transcriber.transcribe({ audio, diarization: true }).pipe(
    Transcriber.requireDiarization,
  )
  return r
}).pipe(Effect.provide(layer))
```

Recipe runner naming follows the established pattern: `run-node.ts`
per memory.

### 3.7 Phase 2 deliverable checklist

- [ ] Markers + combinators added inline in
      [Transcriber.ts](../packages/core/src/transcriber/Transcriber.ts)
      with `@experimental` JSDoc.
- [ ] `fallback` combinator with both gotcha comments verbatim from
      the spike.
- [ ] Layer registrations: ElevenLabs ✓✓, Inworld sync ✓✓ (promoted
      from `Layer.merge`), Inworld realtime ✓✓, OpenAI ✗✗, Gemini ✗✗.
- [ ] OpenAI per-model `wordTimestamps` runtime check removed;
      provider error translation verified.
- [ ] Lyria clip × wav runtime check removed; provider error
      translation verified.
- [ ] ElevenLabs (and any other) STT `prompt` →
      `warnDropped` when no biasing equivalent.
- [ ] Gemini transcriber runtime guards retained as
      defense-in-depth, comment added pointing at §5.
- [ ] MockTranscriber: `layer` ships all three markers (one new
      default change), `layerWithoutDiarization`,
      `layerWithoutWordTimestamps` added.
- [ ] `expectTypeOf` blocks for each marker pair in
      `Transcriber.test.ts` (positive + negative cases for
      `requireX` and `fallback`).
- [ ] Runtime smoke for `fallback` (3 cases) and per-model
      translation (1 case).
- [ ] Recipe at `recipes/transcribe-fallback/run-node.ts`.
- [ ] No changes to
      [domain/Transcript.ts](../packages/core/src/domain/Transcript.ts).

---

## 4. Phase 3 — TTS (SpeechSynthesizer)

Smaller than Phase 2. The two service-level markers
(`TtsIncrementalText`, `MultiSpeakerTts`) already exist
([SpeechSynthesizer.ts:166](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L166),
[:179](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L179))
and providers already ship/omit them correctly.

### 4.1 `fallback` for SpeechSynthesizer

If Phase 2's `IntersectROut` was kept inline in `Transcriber.ts`,
**lift it now** to a shared utilities module. There's no shared
internal module today; pick a location during Phase 3
implementation (`packages/core/src/internal/typeHelpers.ts` is a
reasonable default). Both `Transcriber.ts` and `SpeechSynthesizer.ts`
import from there.

`SpeechSynthesizer.fallback` runtime orElses across all five
service methods (`synthesize`, `streamSynthesis`,
`streamSynthesisFrom`, `synthesizeDialogue`,
`streamSynthesizeDialogue`). Carries existing service-level
markers (`TtsIncrementalText`, `MultiSpeakerTts`) through the
intersection correctly — verify with type tests parallel to §3.5.2.

### 4.2 Pronunciation drops → `Unsupported` (bucket 1)

Per guideline §14.1. Pronunciations are load-bearing — silent drop
= audibly wrong output.

| Provider           | File                                                                                                 | Current                                                             | Fix                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Inworld** TTS    | [InworldSynthesizer.ts:78-95](../packages/providers/inworld/src/InworldSynthesizer.ts#L78)           | non-IPA silently skipped                                            | reject with `AiError.Unsupported` if any non-IPA entry present |
| **ElevenLabs** TTS | [ElevenLabsSynthesizer.ts:79-113](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L79) | whole-array drop on unsupported model; per-item x-sampa silent drop | reject with `Unsupported` for both gaps                        |

Error message convention: `AiError.Unsupported({ capability:
"pronunciations", reason: "Inworld TTS only supports IPA
pronunciation encoding; got 'cmu-arpabet'." })`.

### 4.3 Bucket 2 fixes — instructions

Per guideline §14.5:

- [OpenAISynthesizer.ts:30-31](../packages/providers/openai/src/OpenAISynthesizer.ts#L30) —
  `instructions` silently ignored on `tts-1` / `tts-1-hd`.
  **Fix:** `warnDropped` when caller provides `instructions`
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

### 4.4 No new per-modifier markers for TTS

TTS modifier surface against the §4 failure-vs-degradation rule:

| Modifier                | Verdict                                             |
| ----------------------- | --------------------------------------------------- |
| `pronunciations`        | bucket 1 — `Unsupported` (§4.2 above); not a marker |
| `speed`                 | bucket 3 — silent (clamp)                           |
| `languageCode`          | bucket 3 — silent (inferred from voice)             |
| `instructions` (OpenAI) | bucket 2 — `warnDropped` (§4.3 above)               |
| `outputFormat`          | bucket 1 — already `Unsupported` on Gemini          |

None of these is a marker candidate. No new markers in Phase 3.
Revisit when a TTS feature with a real compliance use case lands
(e.g. SSML support could become a future `SsmlGuarantee` marker).

### 4.5 Phase 3 deliverable checklist

- [ ] `IntersectROut` lifted to shared location.
- [ ] `SpeechSynthesizer.fallback` with marker-intersection tests.
- [ ] Inworld pronunciation: silent drop → `Unsupported`.
- [ ] ElevenLabs pronunciation: two silent drops → `Unsupported`.
- [ ] OpenAI `instructions`: silent → `warnDropped` on
      non-mini-tts models.
- [ ] Mocks (`MockSpeechSynthesizer`) unchanged — Phase 3 adds no
      new markers.
- [ ] Tests for fallback marker intersection over
      `TtsIncrementalText` and `MultiSpeakerTts`.
- [ ] No changes to `SpeechSynthesizerService` shape.

---

## 5. Decisions recap (previously open)

All resolved during the design discussion. Recording here so they
don't get re-litigated mid-implementation.

| Decision                                                 | Resolution                                                                                      | Reasoning                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `requireX` shape                                         | Overloaded function (Effect / Stream), single `as any` in body                                  | Best hover output, best error messages, no inference traps.                                          |
| Marker / combinator location                             | Co-located inline in service module (`Transcriber.ts`), `@experimental` JSDoc                   | Load-bearing for providers; separate sub-path makes the "experimental" label dishonest.              |
| OpenAI STT layer split                                   | **No split.** Ship neither marker pessimistically.                                              | Mixed-model variance is per-model, not per-Layer; per §5 of the guideline, pessimistic registration. |
| `withModel<M>()` escape hatch                            | **Not in Phase 2.** Add lazily when a consumer asks.                                            | Don't speculate.                                                                                     |
| `CapabilityWarning` shape                                | Log-only via `Effect.logWarning`, no typed `AiError` variant                                    | Cheaper; promote only if consumer needs programmatic match.                                          |
| Tag string convention                                    | `@betalyra/effect-uai/capability/<Name>`                                                        | Matches existing `SttStreaming`.                                                                     |
| Per-model variance checks (e.g. OpenAI `wordTimestamps`) | Remove; translate provider errors                                                               | Guideline §2.3 — don't maintain per-model tables.                                                    |
| Per-service tag naming                                   | Per-service classes (`Transcriber.DiarizationGuarantee`); naturally satisfied for STT modifiers | Cross-service modality markers (LLM `AudioInput` etc.) become a real concern only in later phases.   |
| `IntersectROut` location                                 | Inline in `Transcriber.ts` for Phase 2; lift to shared utility in Phase 3 when TTS needs it     | Don't pre-generalise from one example.                                                               |
| `fallback` runtime stability                             | The orElse runtime is stable; the marker-intersection guarantee is `@experimental`              | Different stability axes; document accordingly.                                                      |
| `synthesizeDialogue` as a method on the common service   | Settled in v0.6: stays a method, gated by `MultiSpeakerTts`                                     | Provider stubs already in tree; no factor-out planned.                                               |

---

## 6. Open items (carry over from guideline §11)

- **Third-party Layer authors.** No enforcement that "if you
  implement diarization, you must register the marker." Forgotten
  markers leave consumers stuck on the lax path. Not blocking; raise
  as a doc/lint item.
- **Inter-package wire boundaries.** Marker types don't survive
  JSON serialization. Phase 2 doesn't introduce this problem
  (markers are Layer-side); mention in the recipe doc.
- **`MultiSpeakerTts` granularity.** Today it gates both
  `synthesizeDialogue` and `streamSynthesizeDialogue`. If a provider
  supports one but not the other we'd need to split. Not on the
  roadmap.
- **Promotion criteria from `@experimental`.** What signal warrants
  dropping the tag? Guideline §11 leaves this open.

---

## 7. Out of scope — future phases

- **Phase 4 — Embeddings.** `ImageEmbeddingGuarantee`
  (per modality) when image embedding providers + consumers
  materialise. Also catches up §14.5 task-field warn-and-drop work.
- **Phase 5 — LLM.** `ToolCallingGuarantee`, `VisionGuarantee`,
  later `AudioInputGuarantee` / `VideoInputGuarantee` as multimodal
  providers land. Bigger phase; needs its own plan. Will revisit the
  NARROW question (`cacheControl`, `structured<T>`) but current
  policy says **lax with typed `LLM.structured<T>()` helper**, no
  NARROW marker.
- **Phase 6 — Image generation.** Currently lax. `SeedGuarantee` is
  not on the curated list under current policy.
- **Phase 7 — Music generation.** `MusicInteractiveSession` already
  in tree; no per-modifier markers planned. Confirmed by the
  upcoming ElevenLabs music provider
  ([plans/elevenlabs-music.md](elevenlabs-music.md)) — Eleven Music
  has no bidirectional session, ships no `MusicInteractiveSession`
  marker, and C2PA opt-in does not qualify as a marker under §4
  (bucket 2 at most). The Lyria clip × wav fix in Phase 2 §3.2
  unblocks one of the per-model checks called out in §14.4 of the
  guideline.
- **Future services (video, live, OCR, S2ST, reranker).** Markers
  listed in guideline §7 Tier 3. Land with their respective
  services.

---

## 8. Estimated effort (rough)

| Phase         | Surface touched                                                                                                                                            | Effort     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Phase 0       | 2 small new core files, 1 smoke test                                                                                                                       | 0.5 day    |
| Phase 1       | 2 typed-request `Omit`s, `DialogueTurn` cleanup, 2 embedding error-tag changes, updated tests                                                              | 0.5 day    |
| Phase 2 (STT) | Inline additions to `Transcriber.ts`, ~5 provider Layer blocks, 2 runtime check removals (OpenAI + Lyria), 1-2 `warnDropped` calls, mock + tests, 1 recipe | 1.5-2 days |
| Phase 3 (TTS) | 1 core function + type helper lift, 2 provider pronunciation fixes, 1 instructions fix, tests                                                              | 1 day      |
| Phases 4-7    | Separate plans                                                                                                                                             | —          |

Total Phases 0-3: ~4 days of focused work, broken into 3-4 PRs.
