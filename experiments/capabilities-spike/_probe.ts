/**
 * Type probe — verifies the inferred output types of the Effect.gen
 * variants from the fallback demo. Each `_assert` lines pins what TS
 * computed for that expression. If the assertion no longer holds, this
 * file will fail to typecheck.
 */

import { Effect, Layer } from "effect"
import * as EffectMod from "effect/Effect"
import { Transcription } from "./index.js"

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false

declare const audio: ArrayBuffer
declare const ElevenLabsImpl: Layer.Layer<Transcription.Service>
declare const AssemblyAIImpl: Layer.Layer<Transcription.Service>
declare const OpenAIImpl: Layer.Layer<Transcription.Service>
declare const GeminiImpl: Layer.Layer<Transcription.Service>

const elevenLabsLayer = Layer.mergeAll(
  ElevenLabsImpl,
  Layer.succeed(Transcription.DiarizationGuarantee, undefined),
  Layer.succeed(Transcription.WordTimestampsGuarantee, undefined),
)
const assemblyAILayer = Layer.mergeAll(
  AssemblyAIImpl,
  Layer.succeed(Transcription.DiarizationGuarantee, undefined),
  Layer.succeed(Transcription.WordTimestampsGuarantee, undefined),
)
const openaiLayer = Layer.mergeAll(
  OpenAIImpl,
  Layer.succeed(Transcription.WordTimestampsGuarantee, undefined),
)
const geminiLayer = GeminiImpl

// ===========================================================================
// Variant 1 — LAX: gen function without requires
// ===========================================================================

const lax = Effect.gen(function* () {
  const r = yield* Transcription.transcribe({ audio, diarization: true })
  return r
})

// What is `lax`?
type LaxType = typeof lax
// Result<never> — no narrowing applied
type LaxA = EffectMod.Success<LaxType>
type LaxR = EffectMod.Services<LaxType>

const _laxA: Eq<LaxA, Transcription.Result<never>> = true
const _laxR: Eq<LaxR, Transcription.Service> = true

const laxFallback = Transcription.fallback([elevenLabsLayer, openaiLayer, geminiLayer])
type LaxFallbackROut = Layer.Success<typeof laxFallback>
const _laxFallbackR: Eq<LaxFallbackROut, Transcription.Service> = true
// ↑ Only `Service` survives — markers don't all appear in every tier.

const laxProvided = lax.pipe(Effect.provide(laxFallback))
type LaxProvidedR = EffectMod.Services<typeof laxProvided>
const _laxProvidedR: Eq<LaxProvidedR, never> = true
// ↑ R fully discharged — runnable.

// ===========================================================================
// Variant 2 — STRICT: gen function with requireDiarization + requireWordTimestamps
// ===========================================================================

const strict = Effect.gen(function* () {
  const r = yield* Transcription.transcribe({
    audio,
    diarization: true,
    wordTimestamps: true,
  }).pipe(Transcription.requireDiarization, Transcription.requireWordTimestamps)
  return r
})

type StrictType = typeof strict
type StrictA = EffectMod.Success<StrictType>
type StrictR = EffectMod.Services<StrictType>

// Narrowed to BOTH capabilities
const _strictA: Eq<StrictA, Transcription.Result<"diarization" | "wordTimestamps">> = true
// R now requires the Service AND both guarantee markers
const _strictR: Eq<
  StrictR,
  | Transcription.Service
  | Transcription.DiarizationGuarantee
  | Transcription.WordTimestampsGuarantee
> = true

const strictFallback = Transcription.fallback([elevenLabsLayer, assemblyAILayer])
type StrictFallbackROut = Layer.Success<typeof strictFallback>
const _strictFallbackR: Eq<
  StrictFallbackROut,
  | Transcription.Service
  | Transcription.DiarizationGuarantee
  | Transcription.WordTimestampsGuarantee
> = true
// ↑ Both markers survive — they're in every tier.

const strictProvided = strict.pipe(Effect.provide(strictFallback))
type StrictProvidedR = EffectMod.Services<typeof strictProvided>
const _strictProvidedR: Eq<StrictProvidedR, never> = true

// ===========================================================================
// Variant 3 — PARTIAL: fallback with one missing capability (compile fails)
// ===========================================================================

const partialFallback = Transcription.fallback([
  elevenLabsLayer,
  openaiLayer, // ← lacks DiarizationGuarantee
  assemblyAILayer,
])
type PartialFallbackROut = Layer.Success<typeof partialFallback>
// Only Service + WordTimestamps survive — Diarization dropped.
const _partialFallbackR: Eq<
  PartialFallbackROut,
  Transcription.Service | Transcription.WordTimestampsGuarantee
> = true

// Consuming with only requireWordTimestamps works (WT survived)
const wtOnly = Effect.gen(function* () {
  return yield* Transcription.transcribe({ audio }).pipe(Transcription.requireWordTimestamps)
})
const wtOk = wtOnly.pipe(Effect.provide(partialFallback))
type WtOkR = EffectMod.Services<typeof wtOk>
const _wtOkR: Eq<WtOkR, never> = true

// Consuming with requireDiarization leaves DG unsatisfied
const badProvided = strict.pipe(Effect.provide(partialFallback))
type BadR = EffectMod.Services<typeof badProvided>
const _badR: Eq<BadR, Transcription.DiarizationGuarantee> = true
// ↑ R is NOT `never` — DiarizationGuarantee leaks through.

// @ts-expect-error — can't runPromise with non-never R
void Effect.runPromise(badProvided)
