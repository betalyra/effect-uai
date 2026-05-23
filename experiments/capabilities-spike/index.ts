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

  // ---- (a) Transcription, lax ----------------------------------------------
  const lax = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({
      audio: someAudio,
      diarization: true,
    })
    // r : Transcription.Result — words and speakerId are optional.
    for (const w of r.words ?? []) {
      if (w.speakerId !== undefined) console.log(`[${w.speakerId}] ${w.text}`)
      else console.log(w.text)
    }
  })

  // ---- (b) Transcription, compile-time gated -------------------------------
  // require* adds R requirements but does NOT change the result shape.
  // Single-speaker audio still legitimately returns no speakerId; the
  // consumer's `if (w.speakerId)` is unavoidable.
  const strict = Transcription.transcribe({
    audio: someAudio,
    diarization: true,
    wordTimestamps: true,
  }).pipe(Transcription.requireDiarization, Transcription.requireWordTimestamps)

  const strictConsume = Effect.gen(function* () {
    const r = yield* strict
    // r : Transcription.Result — same shape as lax. The marker handles
    // configuration; the optional checks handle audio reality.
    for (const w of r.words ?? []) {
      if (w.speakerId !== undefined) {
        console.log(`[${w.speakerId}] ${w.text}`)
      } else {
        console.log(w.text)
      }
    }
  })

  // ---- (c) LLM thinking — GATE-ONLY ----------------------------------------
  // requireThinking gates config (provider must support thinking) but does
  // NOT promise reasoning text — the model decides whether to think.
  const llmThinking = LLM.chat({
    messages: [{ role: "user", content: "explain X" }],
    thinking: true,
  }).pipe(LLM.requireThinking)

  const llmThinkingConsume = Effect.gen(function* () {
    const r = yield* llmThinking
    // r.reasoning : string | undefined  — still optional
    if (r.reasoning !== undefined) console.log(r.reasoning)
  })

  // ---- (d) LLM cacheControl — NARROW ---------------------------------------
  // requireCacheControl both gates config AND narrows the result's usage
  // fields. Cache-enabled calls always report cache token counts (possibly 0).
  const llmCached = LLM.chat({
    messages: [{ role: "user", content: "hi" }],
    cacheControl: true,
  }).pipe(LLM.requireCacheControl)

  const llmCachedConsume = Effect.gen(function* () {
    const r = yield* llmCached
    // r.usage.cacheReadInputTokens : number  — narrowed, not `| undefined`
    const cacheHit: number = r.usage.cacheReadInputTokens
    const cacheCreate: number = r.usage.cacheCreationInputTokens
    console.log(`cache: read=${cacheHit} create=${cacheCreate}`)
  })

  // ---- (e) LLM structured output — NARROW ----------------------------------
  // requireStructured<T> claims the output conforms to T. Provider validates
  // schema server-side; success path guarantees `parsed: T`.
  type Recipe = {
    readonly title: string
    readonly steps: ReadonlyArray<string>
  }

  const llmStructured = LLM.chat({
    messages: [{ role: "user", content: "give me a recipe" }],
  }).pipe(LLM.requireStructured<Recipe>())

  const llmStructuredConsume = Effect.gen(function* () {
    const r = yield* llmStructured
    // r.parsed : Recipe  — narrowed, not `| undefined`
    const recipe: Recipe = r.parsed
    console.log(`${recipe.title}: ${recipe.steps.length} steps`)
  })

  // ---- (f) Image gen seed — NARROW -----------------------------------------
  // requireSeed both gates config AND narrows. Seed is echoed (or auto-
  // generated and returned) by any seed-supporting provider, every call.
  const imgWithSeed = ImageGen.generate({ prompt: "a cat", seed: 42 }).pipe(ImageGen.requireSeed)
  const imgWithSeedConsume = Effect.gen(function* () {
    const r = yield* imgWithSeed
    // r.seed : number  — narrowed
    const seed: number = r.seed
    console.log(`generated with seed ${seed}`)
  })

  // ---- (h) Embeddings — no narrowing -----------------------------------------
  // `task` tunes the vector but presence of `vector` doesn't depend on it.
  // Nothing to narrow. Marker still gates config if the caller cares.
  const emb = Effect.gen(function* () {
    const r = yield* Embedding.embed({
      input: "hello",
      task: "classification",
    }).pipe(Embedding.requireTaskTuning)
    return r.vector
  })

  // ---- (f) Provider Layers ship the markers they honor ---------------------
  declare const ElevenLabsImpl: Layer.Layer<Transcription.Service>
  declare const GeminiImpl: Layer.Layer<Transcription.Service>

  // ElevenLabs Scribe honors both → ships both guarantees
  const elevenLabsLayer = Layer.mergeAll(
    ElevenLabsImpl,
    Layer.succeed(Transcription.DiarizationGuarantee, undefined),
    Layer.succeed(Transcription.WordTimestampsGuarantee, undefined),
  )

  // Gemini transcription has neither → ships no guarantees
  const geminiLayer = GeminiImpl

  // ---- (g) Fallback ---------------------------------------------------------
  declare const AssemblyAIImpl: Layer.Layer<Transcription.Service>
  declare const OpenAIImpl: Layer.Layer<Transcription.Service>

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

  // Lax fallback — any combination works, output is widest result type.
  const laxFallback = Transcription.fallback([elevenLabsLayer, openaiLayer, geminiLayer])
  // laxFallback : Layer<Transcription.Service>  (markers don't survive intersection)

  const laxConsumer = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({
      audio: someAudio,
      diarization: true,
    })
    // r : Result<never>
    for (const w of r.words ?? []) {
      if (w.speakerId !== undefined) console.log(`[${w.speakerId}] ${w.text}`)
    }
  }).pipe(Effect.provide(laxFallback))

  // Strict fallback — every tier MUST provide the required marker.
  const strictFallback = Transcription.fallback([elevenLabsLayer, assemblyAILayer])
  // strictFallback : Layer<Service | DiarizationGuarantee | WordTimestampsGuarantee>

  const strictConsumer = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({
      audio: someAudio,
      diarization: true,
      wordTimestamps: true,
    }).pipe(Transcription.requireDiarization, Transcription.requireWordTimestamps)
    for (const w of r.words ?? []) {
      if (w.speakerId !== undefined) {
        console.log(`[${w.speakerId}] ${w.text}`)
      }
    }
  }).pipe(Effect.provide(strictFallback))

  // ---- (g.bad) compile failure on a partial-capability fallback ------------
  // OpenAI lacks DiarizationGuarantee, so the intersection drops Diarization
  // for the whole fallback. Consuming with `requireDiarization` then leaves
  // R = DiarizationGuarantee — a terminal call like runPromise rejects it.
  const partialFallback = Transcription.fallback([
    elevenLabsLayer, // D + WT
    openaiLayer, //     WT only — breaks the intersection for D
    assemblyAILayer, // D + WT
  ])
  // partialFallback : Layer<Service | WordTimestampsGuarantee>

  const partialProvided = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({ audio: someAudio }).pipe(
      Transcription.requireDiarization,
    )
    return r
  }).pipe(Effect.provide(partialFallback))
  // partialProvided services R = DiarizationGuarantee (NOT never).

  // @ts-expect-error — R is not `never`, `runPromise` requires fully discharged R.
  void Effect.runPromise(partialProvided)

  // ===========================================================================
  // Compile-error verification — each @ts-expect-error MUST fire
  // ===========================================================================
  // If any of these directives become "unused" (the line below typechecks),
  // the build breaks. That's the regression check: we've lost a guarantee.

  // ── (E1) GATE-ONLY: requireDiarization against a Layer without the marker ──
  const gemOnlyProvided = Effect.gen(function* () {
    return yield* Transcription.transcribe({ audio: someAudio }).pipe(
      Transcription.requireDiarization,
    )
  }).pipe(Effect.provide(geminiLayer))
  // gemOnlyProvided.R = DiarizationGuarantee (leaked)

  // @ts-expect-error — Gemini layer doesn't ship DiarizationGuarantee
  void Effect.runPromise(gemOnlyProvided)

  // ── (E2) NARROW: reading cache tokens without requireCacheControl ─────────
  const llmLax = Effect.gen(function* () {
    const r = yield* LLM.chat({ messages: [] })
    // @ts-expect-error — `cacheReadInputTokens` is `number | undefined` in lax
    const _bad: number = r.usage.cacheReadInputTokens
    return _bad
  })

  // ── (E3) NARROW: reading parsed without requireStructured ──────────────────
  type Recipe2 = { readonly title: string }
  const llmUnstructured = Effect.gen(function* () {
    const r = yield* LLM.chat({ messages: [] })
    // @ts-expect-error — `parsed` is `undefined` (T = never) without requireStructured
    const _bad: Recipe2 = r.parsed
    return _bad
  })

  // ── (E4) NARROW: reading seed without requireSeed ─────────────────────────
  const imgLax = Effect.gen(function* () {
    const r = yield* ImageGen.generate({ prompt: "x" })
    // @ts-expect-error — `seed` is `number | undefined` in lax
    const _bad: number = r.seed
    return _bad
  })

  // ── (E5) GATE-ONLY: requireCacheControl against a non-caching Layer ───────
  // Same shape as E1 but for a narrowing capability — the narrowing alone
  // doesn't help; the Layer must still satisfy the marker.
  declare const NonCachingImpl: Layer.Layer<LLM.Service>
  const nonCachingLayer = NonCachingImpl

  const llmCachedOnNonCachingProvider = Effect.gen(function* () {
    return yield* LLM.chat({ messages: [], cacheControl: true }).pipe(LLM.requireCacheControl)
  }).pipe(Effect.provide(nonCachingLayer))

  // @ts-expect-error — CacheControlGuarantee not provided by nonCachingLayer
  void Effect.runPromise(llmCachedOnNonCachingProvider)

  // Suppress unused-var lint
  void llmLax
  void llmUnstructured
  void imgLax
  void laxConsumer
  void strictConsumer
  void llmThinkingConsume
  void llmCachedConsume
  void llmStructuredConsume
  void imgWithSeedConsume
  void emb
}

void Demo
