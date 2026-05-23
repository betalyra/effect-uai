/**
 * Capability handling — type-level spike.
 *
 * Self-contained. Does NOT import from @effect-uai/core. Run:
 *
 *   pnpm --filter @effect-uai/spike-capabilities typecheck
 *
 * Demonstrates the proposed pattern across four service shapes:
 *   1. Transcription — diarization, wordTimestamps
 *   2. Embeddings    — task (invisible — no Caps narrowing)
 *   3. LLM           — thinking, cacheControl
 *   4. Image gen     — seed
 *
 * Two natural classes of modifier emerge:
 *   - Visible modifiers: effect changes the output shape
 *     (speakerId, reasoning text, seed echo). Type-narrowing is real.
 *   - Invisible modifiers: effect is internal to the model
 *     (embedding task, parallelToolCalls). Lax/strict methods only.
 */

import { Context, Effect, Layer } from "effect";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

class Unsupported {
  readonly _tag = "Unsupported";
  constructor(
    readonly provider: string,
    readonly capability: string,
    readonly reason: string,
  ) {}
}

// ===========================================================================
// 1. Transcription
// ===========================================================================

export namespace Transcription {
  export type Capability = "diarization" | "wordTimestamps";

  export type Word<Caps extends Capability = never> = {
    readonly text: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly speakerId: "diarization" extends Caps
      ? string
      : string | undefined;
  };

  export type Result<Caps extends Capability = never> = {
    readonly text: string;
    readonly languageCode?: string;
    readonly words: "wordTimestamps" extends Caps
      ? ReadonlyArray<Word<Caps>>
      : ReadonlyArray<Word<Caps>> | undefined;
  };

  export type Request = {
    readonly audio: ArrayBuffer;
    readonly languageCode?: string;
    readonly diarization?: boolean;
    readonly wordTimestamps?: boolean;
  };

  export class Service extends Context.Service<
    Service,
    {
      readonly transcribe: (req: Request) => Effect.Effect<Result, Unsupported>;
    }
  >()("spike/Transcriber") {}

  // Per-modifier guarantee markers — providers ship these to declare
  // they honor the modifier.
  export class DiarizationGuarantee extends Context.Service<
    DiarizationGuarantee,
    void
  >()("spike/Transcriber/DiarizationGuarantee") {}
  export class WordTimestampsGuarantee extends Context.Service<
    WordTimestampsGuarantee,
    void
  >()("spike/Transcriber/WordTimestampsGuarantee") {}

  export const transcribe = (req: Request) =>
    Effect.flatMap(Service.asEffect(), (s) => s.transcribe(req));

  // Caps-narrowing combinators. The cast is the only unsafe spot:
  // TS cannot prove that "R includes the guarantee" implies the runtime
  // shape carries the field. We audit this once and consumers get sound
  // narrowing.
  export const requireDiarization = <C extends Capability, E, R>(
    eff: Effect.Effect<Result<C>, E, R>,
  ): Effect.Effect<Result<C | "diarization">, E, R | DiarizationGuarantee> =>
    Effect.flatMap(DiarizationGuarantee.asEffect(), () => eff) as any;

  export const requireWordTimestamps = <C extends Capability, E, R>(
    eff: Effect.Effect<Result<C>, E, R>,
  ): Effect.Effect<
    Result<C | "wordTimestamps">,
    E,
    R | WordTimestampsGuarantee
  > => Effect.flatMap(WordTimestampsGuarantee.asEffect(), () => eff) as any;

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
  type ROutOf<L> =
    L extends Layer.Layer<infer Out, infer _E, infer _RIn> ? Out : never;

  type IntersectROut<Layers extends ReadonlyArray<Layer.Layer<any, any, any>>> =
    Layers extends readonly [
      infer Head extends Layer.Layer<any, any, any>,
      ...infer Tail extends ReadonlyArray<Layer.Layer<any, any, any>>,
    ]
      ? ROutOf<Head> & IntersectROut<Tail>
      : unknown;

  export const fallback = <
    const Layers extends ReadonlyArray<Layer.Layer<Service, any, any>>,
  >(
    _tiers: Layers,
  ): Layer.Layer<IntersectROut<Layers>> => {
    // Runtime stub. A real impl would materialize each tier in its own scope
    // and chain transcribe calls with Effect.orElse. Type contract is what
    // we care about here.
    return null as any;
  };
}

// ===========================================================================
// 2. Embeddings  (invisible-modifier case)
// ===========================================================================
//
// `task` tunes the vector but doesn't change the output shape. There's
// nothing to narrow at the type level — the result is `ReadonlyArray<number>`
// either way. So embeddings get lax/strict methods but NO requireTask
// combinator. A caller who needs guaranteed task-tuning pins a specific
// provider Layer (Cohere, Jina) directly.
//
// Multi-part input on Jina is a SHAPE failure, not a fidelity failure
// (no vector can be produced). It stays `Unsupported`.

export namespace Embedding {
  export type Result = {
    readonly vector: ReadonlyArray<number>;
    readonly model: string;
    readonly tokensUsed: number;
  };

  export type Request = {
    readonly input: string | ReadonlyArray<string>;
    readonly task?:
      | "search_document"
      | "search_query"
      | "classification"
      | "clustering";
  };

  export class Service extends Context.Service<
    Service,
    {
      readonly embed: (req: Request) => Effect.Effect<Result, Unsupported>;
    }
  >()("spike/Embedder") {}

  export const embed = (req: Request) =>
    Effect.flatMap(Service.asEffect(), (s) => s.embed(req));

  // No guarantee markers. No require* combinators. Invisible modifiers
  // have no shape to narrow; callers wanting a guarantee pin a specific
  // provider Layer directly.
}

// ===========================================================================
// 3. LLM
// ===========================================================================
//
// `thinking` — visible (reasoning text in result) → narrow.
// `cacheControl` — visible (cache token counts in usage) → narrow.
// `parallelToolCalls` — invisible (toolCalls array same shape either way) → lax only.

export namespace LLM {
  export type Capability = "thinking" | "cacheControl";

  export type Usage<Caps extends Capability = never> = {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadInputTokens: "cacheControl" extends Caps
      ? number
      : number | undefined;
    readonly cacheCreationInputTokens: "cacheControl" extends Caps
      ? number
      : number | undefined;
  };

  export type Result<Caps extends Capability = never> = {
    readonly text: string;
    readonly toolCalls?: ReadonlyArray<{
      readonly name: string;
      readonly args: unknown;
    }>;
    readonly reasoning: "thinking" extends Caps ? string : string | undefined;
    readonly usage: Usage<Caps>;
  };

  export type Request = {
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly content: string;
    }>;
    readonly thinking?: boolean;
    readonly cacheControl?: boolean;
    readonly parallelToolCalls?: boolean; // invisible — lax only
  };

  export class Service extends Context.Service<
    Service,
    {
      readonly chat: (req: Request) => Effect.Effect<Result, Unsupported>;
    }
  >()("spike/LLM") {}

  export class ThinkingGuarantee extends Context.Service<
    ThinkingGuarantee,
    void
  >()("spike/LLM/ThinkingGuarantee") {}
  export class CacheControlGuarantee extends Context.Service<
    CacheControlGuarantee,
    void
  >()("spike/LLM/CacheControlGuarantee") {}

  export const chat = (req: Request) =>
    Effect.flatMap(Service.asEffect(), (s) => s.chat(req));

  export const requireThinking = <C extends Capability, E, R>(
    eff: Effect.Effect<Result<C>, E, R>,
  ): Effect.Effect<Result<C | "thinking">, E, R | ThinkingGuarantee> =>
    Effect.flatMap(ThinkingGuarantee.asEffect(), () => eff) as any;

  export const requireCacheControl = <C extends Capability, E, R>(
    eff: Effect.Effect<Result<C>, E, R>,
  ): Effect.Effect<Result<C | "cacheControl">, E, R | CacheControlGuarantee> =>
    Effect.flatMap(CacheControlGuarantee.asEffect(), () => eff) as any;
}

// ===========================================================================
// 4. Image generation
// ===========================================================================
//
// `seed` — visible (echoed in result for reproducibility) → narrow.
// `negativePrompt` — invisible → lax only.

export namespace ImageGen {
  export type Capability = "seed";

  export type Result<Caps extends Capability = never> = {
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly seed: "seed" extends Caps ? number : number | undefined;
  };

  export type Request = {
    readonly prompt: string;
    readonly width?: number;
    readonly height?: number;
    readonly seed?: number;
    readonly negativePrompt?: string; // invisible — lax only
  };

  export class Service extends Context.Service<
    Service,
    {
      readonly generate: (req: Request) => Effect.Effect<Result, Unsupported>;
    }
  >()("spike/ImageGen") {}

  export class SeedGuarantee extends Context.Service<SeedGuarantee, void>()(
    "spike/ImageGen/SeedGuarantee",
  ) {}

  export const generate = (req: Request) =>
    Effect.flatMap(Service.asEffect(), (s) => s.generate(req));

  export const requireSeed = <C extends Capability, E, R>(
    eff: Effect.Effect<Result<C>, E, R>,
  ): Effect.Effect<Result<C | "seed">, E, R | SeedGuarantee> =>
    Effect.flatMap(SeedGuarantee.asEffect(), () => eff) as any;
}

// ===========================================================================
// Demo call sites — typecheck-only. Verifies the narrowing actually flows.
// ===========================================================================

namespace Demo {
  declare const someAudio: ArrayBuffer;

  // ---- (a) Transcription, lax ----------------------------------------------
  const lax = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({
      audio: someAudio,
      diarization: true,
    });
    // r : Transcription.Result<never>
    // r.words is `ReadonlyArray<Word<never>> | undefined`
    for (const w of r.words ?? []) {
      // w.speakerId : string | undefined — caller must narrow
      if (w.speakerId !== undefined) console.log(`[${w.speakerId}] ${w.text}`);
      else console.log(w.text);
    }
  });

  // ---- (b) Transcription, type-level strict --------------------------------
  const strict = Transcription.transcribe({
    audio: someAudio,
    diarization: true,
    wordTimestamps: true,
  }).pipe(
    Transcription.requireDiarization,
    Transcription.requireWordTimestamps,
  );

  const strictConsume = Effect.gen(function* () {
    const r = yield* strict;
    // r.words : ReadonlyArray<Word<"diarization" | "wordTimestamps">> (no undefined)
    for (const w of r.words) {
      const speakerId: string = w.speakerId; // ✓ narrowed, no `| undefined`
      console.log(`[${speakerId}] ${w.text}`);
    }
  });

  // ---- (c) LLM with thinking narrowed --------------------------------------
  const llmStrict = LLM.chat({
    messages: [{ role: "user", content: "explain X" }],
    thinking: true,
  }).pipe(LLM.requireThinking);

  const llmConsume = Effect.gen(function* () {
    const r = yield* llmStrict;
    const reasoning: string = r.reasoning; // ✓ narrowed
    console.log(reasoning);
  });

  // ---- (d) Image gen seed echo ---------------------------------------------
  const imgStrict = ImageGen.generate({ prompt: "a cat", seed: 42 }).pipe(
    ImageGen.requireSeed,
  );
  const imgConsume = Effect.gen(function* () {
    const r = yield* imgStrict;
    const seed: number = r.seed; // ✓ narrowed
    console.log(`generated with seed ${seed}`);
  });

  // ---- (e) Embeddings — no narrowing available -----------------------------
  // `task` is invisible: no requireTask combinator. Caller either trusts
  // the wired-up provider or pins a specific provider Layer directly.
  const emb = Effect.gen(function* () {
    const r = yield* Embedding.embed({
      input: "hello",
      task: "classification",
    });
    return r.vector;
  });

  // ---- (f) Provider Layers ship the markers they honor ---------------------
  declare const ElevenLabsImpl: Layer.Layer<Transcription.Service>;
  declare const GeminiImpl: Layer.Layer<Transcription.Service>;

  // ElevenLabs Scribe honors both → ships both guarantees
  const elevenLabsLayer = Layer.mergeAll(
    ElevenLabsImpl,
    Layer.succeed(Transcription.DiarizationGuarantee, undefined),
    Layer.succeed(Transcription.WordTimestampsGuarantee, undefined),
  );

  // Gemini transcription has neither → ships no guarantees
  const geminiLayer = GeminiImpl;

  // ---- (g) Fallback ---------------------------------------------------------
  declare const AssemblyAIImpl: Layer.Layer<Transcription.Service>;
  declare const OpenAIImpl: Layer.Layer<Transcription.Service>;

  const assemblyAILayer = Layer.mergeAll(
    AssemblyAIImpl,
    Layer.succeed(Transcription.DiarizationGuarantee, undefined),
    Layer.succeed(Transcription.WordTimestampsGuarantee, undefined),
  );

  const openaiLayer = Layer.mergeAll(
    OpenAIImpl,
    Layer.succeed(Transcription.WordTimestampsGuarantee, undefined),
    // no DiarizationGuarantee — OpenAI Whisper can't diarize
  );

  // Lax fallback — any combination works, output is widest result type.
  const laxFallback = Transcription.fallback([
    elevenLabsLayer,
    openaiLayer,
    geminiLayer,
  ]);
  // laxFallback : Layer<Transcription.Service>  (markers don't survive intersection)

  const laxConsumer = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({
      audio: someAudio,
      diarization: true,
    });
    // r : Result<never>
    for (const w of r.words ?? []) {
      if (w.speakerId !== undefined) console.log(`[${w.speakerId}] ${w.text}`);
    }
  }).pipe(Effect.provide(laxFallback));

  // Strict fallback — every tier MUST provide the required marker.
  const strictFallback = Transcription.fallback([
    elevenLabsLayer,
    assemblyAILayer,
  ]);
  // strictFallback : Layer<Service | DiarizationGuarantee | WordTimestampsGuarantee>

  const strictConsumer = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({
      audio: someAudio,
      diarization: true,
      wordTimestamps: true,
    }).pipe(
      Transcription.requireDiarization,
      Transcription.requireWordTimestamps,
    );
    // r.words is non-optional, r.words[0].speakerId is `string`
    for (const w of r.words) {
      console.log(`[${w.speakerId}] ${w.text}`);
    }
  }).pipe(Effect.provide(strictFallback));

  // ---- (g.bad) compile failure on a partial-capability fallback ------------
  // OpenAI lacks DiarizationGuarantee, so the intersection drops Diarization
  // for the whole fallback. Consuming with `requireDiarization` then leaves
  // R = DiarizationGuarantee — a terminal call like runPromise rejects it.
  const partialFallback = Transcription.fallback([
    elevenLabsLayer, // D + WT
    openaiLayer, //     WT only — breaks the intersection for D
    assemblyAILayer, // D + WT
  ]);
  // partialFallback : Layer<Service | WordTimestampsGuarantee>

  const partialProvided = Effect.gen(function* () {
    const r = yield* Transcription.transcribe({ audio: someAudio }).pipe(
      Transcription.requireDiarization,
    );
    return r;
  }).pipe(Effect.provide(partialFallback));
  // partialProvided services R = DiarizationGuarantee (NOT never).

  // @ts-expect-error — R is not `never`, `runPromise` requires fully discharged R.
  void Effect.runPromise(partialProvided);

  // Suppress unused-var lint
  void laxConsumer;
  void strictConsumer;
  void llmConsume;
  void imgConsume;
  void emb;
}

void Demo;
