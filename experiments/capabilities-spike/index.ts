/**
 * Capability handling — type-level spike.
 *
 * Self-contained. Does NOT import from @effect-uai/core. Run:
 *
 *   pnpm --filter @effect-uai/spike-capabilities typecheck
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  CORE DISTINCTION                                                    ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  Every capability earns a GUARANTEE MARKER — a `Context.Service`     ║
 * ║  tag the provider Layer ships when it supports the capability. A     ║
 * ║  `requireX` combinator injects the marker into R, so the wired-up    ║
 * ║  Layer stack is compile-time verified.                               ║
 * ║                                                                      ║
 * ║  ONLY SOME capabilities also earn TYPE NARROWING of the result.     ║
 * ║  The rule:                                                           ║
 * ║                                                                      ║
 * ║    NARROW the field iff its presence is determined by (capability    ║
 * ║    + request) alone — NOT by properties of the input data.           ║
 * ║                                                                      ║
 * ║  NARROWED examples (presence = function of request execution):      ║
 * ║    • Image-gen `seed` echo — provider always echoes or generates    ║
 * ║    • LLM cache-token counts — always reported when caching is on    ║
 * ║    • LLM `parsed` from structured output — schema validated server  ║
 * ║                                                                      ║
 * ║  GATE-ONLY examples (presence also depends on input):               ║
 * ║    • Diarization `speakerId` — single-speaker audio → no speakerId  ║
 * ║    • Word timestamps `words` — empty utterance → empty/missing      ║
 * ║    • Thinking `reasoning` — model may decide not to think           ║
 * ║    • Parallel tool calls — invisible (toolCalls shape unchanged)    ║
 * ║                                                                      ║
 * ║  The lie we avoid: narrowing `speakerId: string` based solely on    ║
 * ║  the marker. Even on a diarizing provider, single-speaker audio     ║
 * ║  legitimately returns no speakerId. The marker would tell the type  ║
 * ║  system "string" but reality returns undefined.                     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Services covered:
 *   1. Transcription — diarization, wordTimestamps    (all GATE-ONLY)
 *   2. Embeddings    — task tuning                    (GATE-ONLY)
 *   3. LLM           — thinking, parallelToolCalls    (GATE-ONLY)
 *                    — cacheControl, structured<T>    (NARROW)
 *   4. Image gen     — seed                           (NARROW)
 */

import { Context, Effect, Layer } from "effect"

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

class Unsupported {
  readonly _tag = "Unsupported"
  constructor(
    readonly provider: string,
    readonly capability: string,
    readonly reason: string,
  ) {}
}

// ===========================================================================
// 1. Transcription  — ALL GATE-ONLY
// ===========================================================================
// diarization      → GATE-ONLY: speakerId depends on multi-speaker audio
// wordTimestamps   → GATE-ONLY: words[] depends on whether any audio existed
//
// Markers gate configuration. Result fields stay optional. Caller writes
// `if (w.speakerId)` because single-speaker audio is real.

export namespace Transcription {
  export type Word = {
    readonly text: string
    readonly startSeconds: number
    readonly endSeconds: number
    readonly speakerId?: string
    readonly confidence?: number
  }

  export type Result = {
    readonly text: string
    readonly languageCode?: string
    readonly words?: ReadonlyArray<Word>
  }

  export type Request = {
    readonly audio: ArrayBuffer
    readonly languageCode?: string
    readonly diarization?: boolean
    readonly wordTimestamps?: boolean
  }

  export class Service extends Context.Service<
    Service,
    {
      readonly transcribe: (req: Request) => Effect.Effect<Result, Unsupported>
    }
  >()("spike/Transcriber") {}

  // Per-modifier guarantee markers — providers ship these to declare
  // they honor the modifier.
  export class DiarizationGuarantee extends Context.Service<DiarizationGuarantee, void>()(
    "spike/Transcriber/DiarizationGuarantee",
  ) {}
  export class WordTimestampsGuarantee extends Context.Service<WordTimestampsGuarantee, void>()(
    "spike/Transcriber/WordTimestampsGuarantee",
  ) {}

  export const transcribe = (req: Request) =>
    Effect.flatMap(Service.asEffect(), (s) => s.transcribe(req))

  // Pure compile-time gate. Adds the guarantee marker to R; does NOT
  // change the result type. The caller still inspects optional fields.
  export const requireDiarization = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | DiarizationGuarantee> =>
    Effect.flatMap(DiarizationGuarantee.asEffect(), () => eff)

  export const requireWordTimestamps = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | WordTimestampsGuarantee> =>
    Effect.flatMap(WordTimestampsGuarantee.asEffect(), () => eff)

  // -------------------------------------------------------------------------
  // fallback: run tiers in order until one succeeds.
  //
  // Type-level claim: the resulting Layer provides only the markers that
  // EVERY tier provides. Marker types from Context.Service are nominally
  // distinct, so `(Service | D | WT) & Service` = `Service` (D and WT are
  // disjoint from Service, so their cross-products collapse to `never`).
  // -------------------------------------------------------------------------

  // `infer _E, infer _RIn` rather than `any, any` — using `any` in
  // contravariant positions makes TS resolve `infer Out` to `unknown`.
  type ROutOf<L> = L extends Layer.Layer<infer Out, infer _E, infer _RIn> ? Out : never

  type IntersectROut<Layers extends ReadonlyArray<Layer.Layer<any, any, any>>> =
    Layers extends readonly [
      infer Head extends Layer.Layer<any, any, any>,
      ...infer Tail extends ReadonlyArray<Layer.Layer<any, any, any>>,
    ]
      ? ROutOf<Head> & IntersectROut<Tail>
      : unknown

  export const fallback = <const Layers extends ReadonlyArray<Layer.Layer<Service, any, any>>>(
    _tiers: Layers,
  ): Layer.Layer<IntersectROut<Layers>> => {
    // Runtime stub. A real impl would materialize each tier in its own scope
    // and chain transcribe calls with Effect.orElse. Type contract is what
    // we care about here.
    return null as any
  }
}

// ===========================================================================
// 2. Embeddings  — ALL GATE-ONLY
// ===========================================================================
// taskTuning      → GATE-ONLY: vector shape unchanged; effect is internal
//
// Multi-part input on Jina is a SHAPE failure (no vector possible) — stays
// `Unsupported`. Capability markers don't apply to no-result-possible cases.

export namespace Embedding {
  export type Result = {
    readonly vector: ReadonlyArray<number>
    readonly model: string
    readonly tokensUsed: number
  }

  export type Request = {
    readonly input: string | ReadonlyArray<string>
    readonly task?: "search_document" | "search_query" | "classification" | "clustering"
  }

  export class Service extends Context.Service<
    Service,
    {
      readonly embed: (req: Request) => Effect.Effect<Result, Unsupported>
    }
  >()("spike/Embedder") {}

  export class TaskTuningGuarantee extends Context.Service<TaskTuningGuarantee, void>()(
    "spike/Embedder/TaskTuningGuarantee",
  ) {}

  export const embed = (req: Request) => Effect.flatMap(Service.asEffect(), (s) => s.embed(req))

  export const requireTaskTuning = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | TaskTuningGuarantee> =>
    Effect.flatMap(TaskTuningGuarantee.asEffect(), () => eff)
}

// ===========================================================================
// 3. LLM  — MIXED
// ===========================================================================
// thinking            → GATE-ONLY: model may decide not to produce reasoning
// parallelToolCalls   → GATE-ONLY: invisible (toolCalls shape unchanged)
// cacheControl        → NARROW:    cache token counts always reported when on
// structured<T>       → NARROW:    schema validated server-side; parsed conforms

export namespace LLM {
  // Capabilities that NARROW the result type. Gate-only capabilities are
  // intentionally NOT in this union — they have markers but no field to narrow.
  export type Capability = "cacheControl" | "structured"

  export type Usage<Caps extends Capability = never> = {
    readonly inputTokens: number
    readonly outputTokens: number
    // NARROW: when cache control is on, providers always report these
    // counters (may be 0, but the field is present). The value is computed
    // from request execution, not output content.
    readonly cacheReadInputTokens: "cacheControl" extends Caps ? number : number | undefined
    readonly cacheCreationInputTokens: "cacheControl" extends Caps ? number : number | undefined
  }

  export type Result<T = never, Caps extends Capability = never> = {
    readonly text: string
    // GATE-ONLY: model may or may not call tools — depends on the prompt
    readonly toolCalls?: ReadonlyArray<{
      readonly name: string
      readonly args: unknown
    }>
    // GATE-ONLY: even with thinking enabled, the model may decide that
    // no reasoning was needed and emit an empty/absent reasoning block.
    readonly reasoning?: string
    // NARROW via T: structured output is validated server-side. If the
    // call succeeded with `requireStructured<T>()`, `parsed` conforms to T.
    // For lax (T = never) calls, `parsed` collapses to `undefined`.
    readonly parsed: "structured" extends Caps ? T : T | undefined
    readonly usage: Usage<Caps>
  }

  export type Request = {
    readonly messages: ReadonlyArray<{
      readonly role: string
      readonly content: string
    }>
    readonly thinking?: boolean
    readonly cacheControl?: boolean
    readonly parallelToolCalls?: boolean
  }

  export class Service extends Context.Service<
    Service,
    {
      readonly chat: (req: Request) => Effect.Effect<Result, Unsupported>
    }
  >()("spike/LLM") {}

  export class ThinkingGuarantee extends Context.Service<ThinkingGuarantee, void>()(
    "spike/LLM/ThinkingGuarantee",
  ) {}
  export class CacheControlGuarantee extends Context.Service<CacheControlGuarantee, void>()(
    "spike/LLM/CacheControlGuarantee",
  ) {}
  export class ParallelToolCallsGuarantee extends Context.Service<
    ParallelToolCallsGuarantee,
    void
  >()("spike/LLM/ParallelToolCallsGuarantee") {}
  export class StructuredOutputGuarantee extends Context.Service<StructuredOutputGuarantee, void>()(
    "spike/LLM/StructuredOutputGuarantee",
  ) {}

  export const chat = (req: Request) => Effect.flatMap(Service.asEffect(), (s) => s.chat(req))

  // ── GATE-ONLY combinators: add marker to R, do not change result type ──

  export const requireThinking = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | ThinkingGuarantee> =>
    Effect.flatMap(ThinkingGuarantee.asEffect(), () => eff)

  export const requireParallelToolCalls = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | ParallelToolCallsGuarantee> =>
    Effect.flatMap(ParallelToolCallsGuarantee.asEffect(), () => eff)

  // ── NARROWING combinators: add marker to R AND narrow the result type ──
  // The `as any` cast bridges what TS can't prove: that the marker in R
  // implies the runtime shape. Audited once here, sound by construction.

  export const requireCacheControl = <T, C extends Capability, E, R>(
    eff: Effect.Effect<Result<T, C>, E, R>,
  ): Effect.Effect<Result<T, C | "cacheControl">, E, R | CacheControlGuarantee> =>
    Effect.flatMap(CacheControlGuarantee.asEffect(), () => eff) as any

  // requireStructured takes the expected output type as an explicit type
  // arg (caller supplies the schema; here we just carry T at the type level).
  export const requireStructured =
    <U>() =>
    <T, C extends Capability, E, R>(
      eff: Effect.Effect<Result<T, C>, E, R>,
    ): Effect.Effect<Result<U, C | "structured">, E, R | StructuredOutputGuarantee> =>
      Effect.flatMap(StructuredOutputGuarantee.asEffect(), () => eff) as any
}

// ===========================================================================
// 4. Image generation
// ===========================================================================
//
// ===========================================================================
// 4. Image generation  — MIXED
// ===========================================================================
// seed               → NARROW: provider always echoes the request seed, or
//                              generates one and returns it. Presence is a
//                              function of request execution, not prompt.
// negativePrompt     → GATE-ONLY: invisible (no output field)

export namespace ImageGen {
  export type Capability = "seed"

  export type Result<Caps extends Capability = never> = {
    readonly url: string
    readonly width: number
    readonly height: number
    // NARROW: providers that support seed always emit it. Either echo of
    // the request value or the auto-generated one. Never absent when on.
    readonly seed: "seed" extends Caps ? number : number | undefined
  }

  export type Request = {
    readonly prompt: string
    readonly width?: number
    readonly height?: number
    readonly seed?: number
    readonly negativePrompt?: string
  }

  export class Service extends Context.Service<
    Service,
    {
      readonly generate: (req: Request) => Effect.Effect<Result, Unsupported>
    }
  >()("spike/ImageGen") {}

  export class SeedGuarantee extends Context.Service<SeedGuarantee, void>()(
    "spike/ImageGen/SeedGuarantee",
  ) {}
  export class NegativePromptGuarantee extends Context.Service<NegativePromptGuarantee, void>()(
    "spike/ImageGen/NegativePromptGuarantee",
  ) {}

  export const generate = (req: Request) =>
    Effect.flatMap(Service.asEffect(), (s) => s.generate(req))

  // NARROWING combinator
  export const requireSeed = <C extends Capability, E, R>(
    eff: Effect.Effect<Result<C>, E, R>,
  ): Effect.Effect<Result<C | "seed">, E, R | SeedGuarantee> =>
    Effect.flatMap(SeedGuarantee.asEffect(), () => eff) as any

  // GATE-ONLY combinator
  export const requireNegativePrompt = <A, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | NegativePromptGuarantee> =>
    Effect.flatMap(NegativePromptGuarantee.asEffect(), () => eff)
}

// ===========================================================================
// Demo call sites — typecheck-only. Verifies the narrowing actually flows.
// ===========================================================================

namespace Demo {
  declare const someAudio: ArrayBuffer

  // Provider Layer stubs — declared up front so each section can reach for
  // them. Each layer ships markers for the capabilities its provider honors.
  declare const ElevenLabsImpl: Layer.Layer<Transcription.Service>
  declare const AssemblyAIImpl: Layer.Layer<Transcription.Service>
  declare const OpenAIImpl: Layer.Layer<Transcription.Service>
  declare const GeminiImpl: Layer.Layer<Transcription.Service>
  declare const CachingLLMImpl: Layer.Layer<LLM.Service>
  declare const NonCachingLLMImpl: Layer.Layer<LLM.Service>

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
    // no DiarizationGuarantee — OpenAI Whisper can't diarize
  )
  const geminiLayer = GeminiImpl // ships nothing — Gemini STT has neither cap
  const cachingLLMLayer = Layer.mergeAll(
    CachingLLMImpl,
    Layer.succeed(LLM.CacheControlGuarantee, undefined),
  )
  const nonCachingLLMLayer = NonCachingLLMImpl

  // ==========================================================================
  // (a) Transcription — LAX (no requires)
  // ==========================================================================
  const lax = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({
      audio: someAudio,
      diarization: true,
    })
    // r.words?.[0].speakerId : string | undefined — caller narrows by check.
    for (const w of r.words ?? []) {
      if (w.speakerId !== undefined) console.log(`[${w.speakerId}] ${w.text}`)
      else console.log(w.text)
    }
  })

  // ==========================================================================
  // (b) Transcription — GATE-ONLY (requireDiarization + requireWordTimestamps)
  // ==========================================================================
  // ✓ Compiles and runs against a layer that ships both markers.
  const strictOk = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({
      audio: someAudio,
      diarization: true,
      wordTimestamps: true,
    }).pipe(Transcription.requireDiarization, Transcription.requireWordTimestamps)
    // result shape UNCHANGED — speakerId still optional. Marker only gates config.
    for (const w of r.words ?? []) {
      if (w.speakerId !== undefined) console.log(`[${w.speakerId}] ${w.text}`)
    }
  }).pipe(Effect.provide(elevenLabsLayer))
  void Effect.runPromise(strictOk)

  // ✗ Same call against Gemini (ships no markers) — gate fails.
  const strictBad = Effect.gen(function* () {
    return yield* Transcription.transcribe({ audio: someAudio }).pipe(
      Transcription.requireDiarization,
    )
  }).pipe(Effect.provide(geminiLayer))
  // strictBad.R = DiarizationGuarantee (leaked, NOT never)
  // @ts-expect-error — Gemini layer doesn't ship DiarizationGuarantee
  void Effect.runPromise(strictBad)

  // ==========================================================================
  // (c) LLM thinking — GATE-ONLY (no narrowing case to fail)
  // ==========================================================================
  // ✓ requireThinking gates config; reasoning stays optional (model decides).
  const thinkingOk = Effect.gen(function* () {
    const r = yield* LLM.chat({
      messages: [{ role: "user", content: "explain X" }],
      thinking: true,
    }).pipe(LLM.requireThinking)
    // r.reasoning : string | undefined  — still optional, no narrowing
    if (r.reasoning !== undefined) console.log(r.reasoning)
  })
  void thinkingOk

  // ==========================================================================
  // (d) LLM cacheControl — NARROW
  // ==========================================================================
  // ✓ Narrows cache token counts to `number` AND requires the layer to ship
  //   CacheControlGuarantee.
  const cachedOk = Effect.gen(function* () {
    const r = yield* LLM.chat({ messages: [], cacheControl: true }).pipe(LLM.requireCacheControl)
    // r.usage.cacheReadInputTokens : number  (narrowed)
    const cacheHit: number = r.usage.cacheReadInputTokens
    const cacheCreate: number = r.usage.cacheCreationInputTokens
    console.log(`cache: read=${cacheHit} create=${cacheCreate}`)
  }).pipe(Effect.provide(cachingLLMLayer))
  void Effect.runPromise(cachedOk)

  // ✗ Reading the narrowed field WITHOUT piping requireCacheControl — narrow fails.
  const cachedNarrowBad = Effect.gen(function* () {
    const r = yield* LLM.chat({ messages: [] })
    // @ts-expect-error — `cacheReadInputTokens` is `number | undefined` in lax
    const _bad: number = r.usage.cacheReadInputTokens
    return _bad
  })
  void cachedNarrowBad

  // ✗ Piping requireCacheControl against a non-caching layer — gate fails.
  const cachedGateBad = Effect.gen(function* () {
    return yield* LLM.chat({ messages: [], cacheControl: true }).pipe(LLM.requireCacheControl)
  }).pipe(Effect.provide(nonCachingLLMLayer))
  // @ts-expect-error — CacheControlGuarantee not in nonCachingLLMLayer
  void Effect.runPromise(cachedGateBad)

  // ==========================================================================
  // (e) LLM structured<T> — NARROW
  // ==========================================================================
  // ✓ Schema validated server-side; `parsed` narrowed to T.
  type Recipe = {
    readonly title: string
    readonly steps: ReadonlyArray<string>
  }
  const structuredOk = Effect.gen(function* () {
    const r = yield* LLM.chat({
      messages: [{ role: "user", content: "give me a recipe" }],
    }).pipe(LLM.requireStructured<Recipe>())
    // r.parsed : Recipe  (narrowed, not `| undefined`)
    const recipe: Recipe = r.parsed
    console.log(`${recipe.title}: ${recipe.steps.length} steps`)
  })
  void structuredOk

  // ✗ Reading parsed without requireStructured — narrow fails.
  const structuredBad = Effect.gen(function* () {
    const r = yield* LLM.chat({ messages: [] })
    // @ts-expect-error — `parsed` is `undefined` (T = never) without requireStructured
    const _bad: Recipe = r.parsed
    return _bad
  })
  void structuredBad

  // ==========================================================================
  // (f) ImageGen seed — NARROW
  // ==========================================================================
  // ✓ Seed echoed (or auto-generated and returned) every call.
  const seedOk = Effect.gen(function* () {
    const r = yield* ImageGen.generate({ prompt: "a cat", seed: 42 }).pipe(ImageGen.requireSeed)
    // r.seed : number  (narrowed)
    const seed: number = r.seed
    console.log(`generated with seed ${seed}`)
  })
  void seedOk

  // ✗ Reading seed without requireSeed — narrow fails.
  const seedBad = Effect.gen(function* () {
    const r = yield* ImageGen.generate({ prompt: "x" })
    // @ts-expect-error — `seed` is `number | undefined` in lax
    const _bad: number = r.seed
    return _bad
  })
  void seedBad

  // ==========================================================================
  // (g) Embeddings — GATE-ONLY (no narrowing — vector shape unchanged)
  // ==========================================================================
  const emb = Effect.gen(function* () {
    const r = yield* Embedding.embed({
      input: "hello",
      task: "classification",
    }).pipe(Embedding.requireTaskTuning)
    return r.vector
  })
  void emb

  // ==========================================================================
  // (h) Fallback — marker intersection across tiers
  // ==========================================================================
  // ✓ Lax fallback works with any combination (no markers required).
  const laxFallback = Transcription.fallback([elevenLabsLayer, openaiLayer, geminiLayer])
  // laxFallback : Layer<Service>  (no marker survives the intersection)
  const laxFallbackUse = lax.pipe(Effect.provide(laxFallback))
  void Effect.runPromise(laxFallbackUse)

  // ✓ Strict fallback — every tier ships both markers, both survive.
  const strictFallback = Transcription.fallback([elevenLabsLayer, assemblyAILayer])
  // strictFallback : Layer<Service | DiarizationGuarantee | WordTimestampsGuarantee>
  const strictFallbackUse = Effect.gen(function* () {
    return yield* Transcription.transcribe({ audio: someAudio }).pipe(
      Transcription.requireDiarization,
      Transcription.requireWordTimestamps,
    )
  }).pipe(Effect.provide(strictFallback))
  void Effect.runPromise(strictFallbackUse)

  // ✗ Partial fallback — one tier lacks DiarizationGuarantee → it drops from
  //   the intersection. Consuming with requireDiarization leaks the marker
  //   into R, and runPromise rejects.
  const partialFallback = Transcription.fallback([
    elevenLabsLayer, // D + WT
    openaiLayer, //     WT only — breaks the intersection for D
    assemblyAILayer, // D + WT
  ])
  // partialFallback : Layer<Service | WordTimestampsGuarantee>
  const partialFallbackUse = Effect.gen(function* () {
    return yield* Transcription.transcribe({ audio: someAudio }).pipe(
      Transcription.requireDiarization,
    )
  }).pipe(Effect.provide(partialFallback))
  // @ts-expect-error — DiarizationGuarantee leaks; R is not `never`.
  void Effect.runPromise(partialFallbackUse)
}

void Demo
