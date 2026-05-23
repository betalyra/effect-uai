# Capability Handling — Guideline

How effect-uai expresses provider gaps in the type system. Updated after
the [capabilities spike](../experiments/capabilities-spike/index.ts)
landed; supersedes the earlier inventory-style draft (see git history).

---

## TL;DR

Every capability that a provider may or may not honor earns a
**guarantee marker** — a `Context.Service<X, void>` tag a provider Layer
ships when (and only when) it supports the capability. A
`requireX` combinator injects the marker into the effect's `R` channel.
The wired-up Layer stack is then **compile-time verified**:
`Effect.runPromise` (or any terminal needing `R = never`) rejects when
some required marker isn't provided.

A small subset of capabilities **also narrow the result type**. The
rule:

> Narrow the field iff its presence is determined by (capability +
> request) alone — not by properties of the input data.

Everything else stays as a flat optional field. The caller still writes
`if (w.speakerId)` because single-speaker audio is real.

---

## 1. Why markers, and why not narrow everywhere

Two questions are easy to conflate:

1. **Is the stack configured to attempt the capability?** Answerable
   from the Layer alone. Static. Catches real misconfigurations.
2. **Will the output actually contain the field?** Depends on the
   input, not just the Layer.

The earlier `Caps`-phantom design (now removed) narrowed result fields
based solely on (1) — i.e. it answered (2) using (1)'s data. That over-
promised: a diarizing provider on single-speaker audio legitimately
returns no `speakerId`, even though every marker said it would.

Markers stay because (1) is real and worth catching. Narrowing applies
only when (2) collapses into (1) — when the field's presence is fully
determined by what was requested, with no input dependency.

---

## 2. The decision rule

For each modifier flag a provider may or may not honor, walk this
question tree:

1. **Can the provider produce a result of any shape with this input?**
   - No → `AiError.Unsupported`. No marker, no narrowing. Examples:
     image part on a text-only embedder, multi-part `content[]` on Jina.
   - Yes → continue.
2. **Does (capability + request) fully determine whether the field is
   present in the output?**
   - Yes → **NARROW** + marker. The combinator narrows the result type
     AND adds the marker to `R`.
   - No → **GATE-ONLY** + marker. The combinator only adds the marker
     to `R`; the result type is unchanged and the field stays optional.

---

## 3. Cataloging existing modifiers

| Service | Modifier | Verdict | Reason |
|---|---|---|---|
| Transcription | `diarization` | GATE-ONLY | `speakerId` depends on multi-speaker audio. Single-speaker → absent on any provider. |
| Transcription | `wordTimestamps` | GATE-ONLY | `words[]` depends on whether any audio was transcribed. Empty utterance → absent. |
| Transcription | `language` hint | GATE-ONLY | Effect on output is shape-invariant. |
| Embeddings | `task` tuning | GATE-ONLY | Vector shape unchanged; effect is internal. |
| TTS | `pronunciations` | GATE-ONLY | Audio shape unchanged; effect is internal. |
| TTS | `instructions` (Octave style desc) | GATE-ONLY | Audio shape unchanged. |
| LLM | `thinking` / `reasoning_effort` | GATE-ONLY | Model may decide not to think; `reasoning` legitimately absent. |
| LLM | `parallelToolCalls` | GATE-ONLY | `toolCalls[]` shape unchanged whether parallel or serial. |
| **LLM** | **`cacheControl`** | **NARROW** | Cache token counts (`cacheReadInputTokens`, `cacheCreationInputTokens`) always reported when caching is on, even if 0. Value is a function of request execution, not output content. |
| **LLM** | **`structured<T>`** | **NARROW** | Schema is validated server-side. Success path guarantees `parsed: T`; non-conforming output fails the call entirely. |
| **Image gen** | **`seed`** | **NARROW** | Provider always echoes the passed seed or returns the auto-generated one. Presence is a function of capability alone, never of prompt content. |

The pattern of the NARROW cases: **the field's value is a property of
the request execution, not the model's output.** Seed echo, token
counts, schema-validated parse — all three are computed at the
boundary, not produced by the model freely.

---

## 4. Implementation shape

The reference is the spike at
[`experiments/capabilities-spike/index.ts`](../experiments/capabilities-spike/index.ts).
The typecheck is the test (`pnpm --filter @effect-uai/spike-capabilities typecheck`).

### 4.1 Markers — one class per capability

```ts
export class DiarizationGuarantee extends Context.Service<DiarizationGuarantee, void>()(
  "@effect-uai/transcriber/DiarizationGuarantee",
) {}
```

Existing markers in core that follow this pattern:

- `SttStreaming` — [Transcriber.ts:80](../packages/core/src/transcriber/Transcriber.ts#L80)
- `TtsIncrementalText` — [SpeechSynthesizer.ts:162](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L162)
- `MultiSpeakerTts` — [SpeechSynthesizer.ts:180](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L180)
- `MusicInteractiveSession` — [MusicGenerator.ts:68](../packages/core/src/music-generator/MusicGenerator.ts#L68)
- The whole `Sandbox*` family — [Sandbox.ts:419+](../packages/core/src/sandbox/Sandbox.ts#L419)

Per-modifier markers (the ones this guideline adds) sit alongside these
service-level markers using the same shape.

### 4.2 GATE-ONLY combinator — pure R injection

```ts
export const requireDiarization = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | DiarizationGuarantee> =>
  Effect.flatMap(DiarizationGuarantee.asEffect(), () => eff)
```

No casts. No result-type machinery.

### 4.3 NARROW combinator — R injection + result type narrowing

```ts
// Capabilities that participate in narrowing for this service:
export type Capability = "cacheControl" | "structured"

export type Usage<Caps extends Capability = never> = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: "cacheControl" extends Caps
    ? number
    : number | undefined
  readonly cacheCreationInputTokens: "cacheControl" extends Caps
    ? number
    : number | undefined
}

export const requireCacheControl = <T, C extends Capability, E, R>(
  eff: Effect.Effect<Result<T, C>, E, R>,
): Effect.Effect<Result<T, C | "cacheControl">, E, R | CacheControlGuarantee> =>
  Effect.flatMap(CacheControlGuarantee.asEffect(), () => eff) as any
```

The `as any` cast bridges what TS can't prove: that the marker in `R`
implies the runtime shape carries the field. Audited once at the
combinator definition; sound for the caller.

### 4.4 Provider Layers — ship markers for what you honor

```ts
// ElevenLabs Scribe diarizes and emits word timestamps
export const elevenLabsLayer = (cfg: Config) =>
  Layer.mergeAll(
    impl(cfg),
    Layer.succeed(DiarizationGuarantee, undefined),
    Layer.succeed(WordTimestampsGuarantee, undefined),
  )

// Gemini transcription does neither — ships no per-modifier markers
export const geminiLayer = (cfg: Config) => impl(cfg)
```

Per-model variance lives in per-model Layers, not in conditional marker
registration. If `OpenAIWhisper1` supports `wordTimestamps` but
`OpenAIGpt4oTranscribe` doesn't, that's two separate Layers.

### 4.5 Fallback — marker intersection across tiers

```ts
const fb = Transcriber.fallback([elevenLabs, assemblyAI, deepgram])
// fb : Layer<Service | DiarizationGuarantee | WordTimestampsGuarantee>

const fb2 = Transcriber.fallback([elevenLabs, openai, gemini])
// fb2 : Layer<Service>  — markers don't all survive
```

A marker survives only if **every tier** ships it. Type-level
implementation uses tuple-distributed `&` over each tier's `ROut`,
which collapses correctly because marker types are nominally distinct.

Two implementation gotchas (both burned us in the spike):

- The combinator's type parameter must be `<const Layers extends …>`
  — without `const`, TS widens the array literal to a union and the
  tuple-tail recursion silently breaks (yields `unknown`).
- Extracting `ROut` from `Layer.Layer<infer Out, …>` requires
  `infer _E, infer _RIn` for the other slots. Using `any, any` makes
  TS resolve `infer Out` to `unknown` (contravariant inference quirk).

---

## 5. Caller-side ergonomics

### Lax — render what you got

```ts
const r = yield* Transcriber.transcribe({ audio, diarization: true })
for (const w of r.words ?? []) {
  if (w.speakerId !== undefined) renderSpeaker(w)
  else renderPlain(w)
}
```

No requires. Caller inspects optional fields. Works with any
provider configuration.

### Compile-time gate

```ts
const r = yield* Transcriber.transcribe({ audio, diarization: true })
  .pipe(Transcriber.requireDiarization)
// Result shape UNCHANGED — speakerId still optional. Layer stack is
// guaranteed to support diarization, but single-speaker audio is real.
for (const w of r.words ?? []) {
  if (w.speakerId !== undefined) renderSpeaker(w)
}
```

`requireDiarization` adds the marker to `R`. A provider stack that
doesn't ship `DiarizationGuarantee` fails to satisfy the gate at
`Effect.runPromise`.

### Narrowed

```ts
const r = yield* LLM.chat({ messages, cacheControl: true })
  .pipe(LLM.requireCacheControl)
// r.usage.cacheReadInputTokens : number  (narrowed, not `| undefined`)
const cacheHit: number = r.usage.cacheReadInputTokens
```

Same shape as the gate-only path plus result narrowing. Caller can
drop the `if` guard on the narrowed field.

---

## 6. What this isn't

This guideline does NOT cover:

- **Per-input data-dependent failure**: model × flag interactions
  (OpenAI `wordTimestamps` only on `whisper-1`). Handle with typed
  per-model request types or runtime guards; markers are static.
- **Streaming events**: `final` events can carry narrowing fine.
  `partial` events are conservative (no narrowing) for now.
- **Conditional config-dependent registration**: `enterprise`-tier
  Layers shipping more markers than `free`. Requires per-config Layer
  constructors; see "Open questions."

---

## 7. Open questions

- **Third-party Layer authors.** No enforcement that "if you implement
  diarization, you must register `DiarizationGuarantee`." Forgotten
  markers leave consumers stuck on the lax path.
- **Inter-package wire boundaries.** Narrowed types don't survive
  serialization to JSON. Out-of-process consumers see the wide type
  only.
- **Whether to add markers for "invisible" modifiers** (parallel tool
  calls, embedding task). Cheap to add; adds API surface. Currently
  added when there's a plausible "I want to assert this configuration"
  use case.

---

## 8. Anti-pattern: the lie we're avoiding

Don't do this:

```ts
// ❌ Result type narrows speakerId to string based on marker alone.
type Word<Caps> = {
  readonly speakerId: "diarization" extends Caps ? string : string | undefined
  // ...
}
```

Even on a fully-diarizing provider, a single-speaker audio clip
returns words with no `speakerId`. The narrowed type promises
`string`; runtime gives `undefined`. Consumer trusts the type and
crashes.

The general form: a field whose value the model emits *based on input
content* (clusters, segments, frames, tokens) is not safe to narrow
on a marker. The marker tells you the provider *tried*, not that the
*output carries it.*

Honest version:

```ts
// ✓ Field stays optional. Marker gates configuration.
type Word = {
  readonly speakerId?: string
  // ...
}

const requireDiarization = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  // adds DiarizationGuarantee to R; does not touch the result type
  Effect.flatMap(DiarizationGuarantee.asEffect(), () => eff)
```
