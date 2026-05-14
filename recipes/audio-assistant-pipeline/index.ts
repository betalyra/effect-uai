/**
 * Voice-assistant pipeline: streaming STT → queued LLM (Gemini Flash) →
 * streaming TTS, all wired together as one continuous Effect.
 *
 *   mic frames → Transcriber.streamTranscriptionFrom → TranscriptEvent
 *               ├─ partial → status to UI
 *               └─ final   → enqueue userText, emit to UI
 *
 *   userTextQueue → consumer fiber → handleUtterance:
 *     append user turn to history
 *     LanguageModel.streamTurn ── text_deltas ──► SpeechSynthesizer.streamSynthesisFrom
 *                              └─ delta to UI                 └─ audio bytes to UI
 *     append assistant turn to history
 *
 * The recipe is provider-agnostic. Pick concrete Layers in the runner —
 * `ElevenLabsTranscriber` + `Gemini` + `ElevenLabsSynthesizer` for the
 * defaults.
 *
 * Barge-in is **not** modelled — utterances queue while the assistant is
 * speaking and play back in order. See README for the design tradeoff.
 */
import { Cause, Duration, Effect, Match, Queue, Ref, Stream } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as Transcriber from "@effect-uai/core/Transcriber"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// drainBurst — block on the first item, then keep collecting while the next
// item arrives within `settle` of the previous. Coalesces close-together
// `final` transcripts (e.g. STT split a single sentence on a mid-sentence
// pause) into one LLM round-trip. Mirrors the pattern from `agentic-loop`.
// ---------------------------------------------------------------------------

const drainBurst = <A>(
  queue: Queue.Queue<A>,
  settle: Duration.Input,
): Effect.Effect<ReadonlyArray<A>> =>
  Stream.unfold(false, (started) =>
    started
      ? Effect.race(
          Queue.take(queue).pipe(Effect.map((m) => [m, true] as const)),
          Effect.sleep(settle).pipe(Effect.as(undefined)),
        )
      : Queue.take(queue).pipe(Effect.map((m) => [m, true] as const)),
  ).pipe(Stream.runCollect)

// ---------------------------------------------------------------------------
// Wire shapes — what the server sends to the browser as JSON status frames.
// Binary frames carry TTS audio bytes (PCM s16le @ playback rate).
// ---------------------------------------------------------------------------

export type StatusEvent =
  | { readonly type: "user-partial"; readonly text: string }
  | { readonly type: "user-final"; readonly text: string }
  | { readonly type: "assistant-thinking" }
  | { readonly type: "assistant-delta"; readonly text: string }
  | { readonly type: "assistant-done"; readonly text: string }
  | { readonly type: "error"; readonly message: string }

// ---------------------------------------------------------------------------
// Config — model identifiers + formats. Recipe-level constants, surfaced
// so the runner can override (e.g. switch voices via env).
// ---------------------------------------------------------------------------

export type PipelineConfig = {
  readonly stt: {
    readonly model: string
    readonly inputFormat: AudioFormat
  }
  readonly llm: {
    readonly model: string
    readonly systemPrompt: string
  }
  readonly tts: {
    readonly model: string
    readonly voiceId: string
    readonly outputFormat: AudioFormat
  }
  /**
   * Burst window for coalescing rapid `final` STT events into one LLM call.
   * STT VAD sometimes splits a single sentence into two finals on a brief
   * mid-sentence pause; without coalescing we'd run two LLM round-trips
   * and play two TTS responses for what the user perceived as one prompt.
   */
  readonly utteranceSettle: Duration.Input
}

export const defaultConfig: PipelineConfig = {
  stt: {
    model: "scribe_v2_realtime",
    inputFormat: {
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    },
  },
  llm: {
    model: "gemini-2.5-flash",
    systemPrompt: [
      // Always write the brand name as `effect-uai`. A server-side phonetic
      // rewrite (`effect-uai` → `effect why`) handles pronunciation before
      // text hits the TTS engine, so the UI still shows the proper name.
      "You are the assistant for effect-uai — a TypeScript library, built on",
      "Effect, for writing AI applications by composing small primitives",
      "instead of configuring a framework. You see every text delta, tool",
      "call, and turn-complete event; the loop is a function you call;",
      "providers are interchangeable layers; tools are typed Effects. Think",
      "shadcn, but for AI loops.",
      "",
      "Voice-output rules:",
      "- One or two short sentences. No lists, code, or markdown — spoken aloud.",
      "- Always write the brand name as `effect-uai`.",
      "- If asked who you are or what effect-uai is, give a one-sentence pitch.",
    ].join("\n"),
  },
  tts: {
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    outputFormat: {
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 48000,
      channels: 1,
    },
  },
  utteranceSettle: "350 millis",
}

// ---------------------------------------------------------------------------
// Phonetic spelling for TTS. `eleven_flash_v2_5` doesn't support inline
// SSML phonemes, so we rewrite the brand name on the wire before sending
// it to ElevenLabs while preserving the original text in the UI status.
// Gemini Flash typically emits multi-word deltas — a per-delta substring
// replace covers the realistic cases; we apply it after the LLM stream
// and before it feeds streamSynthesisFrom.
// ---------------------------------------------------------------------------

/**
 * Per-delta text rewrites applied just before the TTS WS. The UI sees the
 * LLM's original text; only the speech engine sees the rewrites.
 *
 * - Brand-name pronunciation: ElevenLabs Flash doesn't honor inline SSML
 *   phonemes, so we phoneticize on the wire.
 * - Markdown stripping: the system prompt asks for no markdown, but models
 *   occasionally relapse into backticks / asterisks. Strip them so the
 *   speech engine doesn't read "backtick effect-uai backtick" aloud.
 */
const TTS_REWRITES: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  [/effect-uai/gi, "effect why"],
  [/[`*_]/g, ""],
]

const phoneticize = (text: string): string =>
  TTS_REWRITES.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), text)

// ---------------------------------------------------------------------------
// One utterance round-trip — LLM stream piped into TTS stream.
// ---------------------------------------------------------------------------

const handleUtterance =
  (
    cfg: PipelineConfig,
    history: Ref.Ref<ReadonlyArray<Items.Item>>,
    sendStatus: (event: StatusEvent) => Effect.Effect<void>,
    sendAudio: (bytes: Uint8Array) => Effect.Effect<void>,
  ) =>
  (userText: string) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("[pipeline] processing utterance", { userText })
      yield* sendStatus({ type: "assistant-thinking" })

      yield* Ref.update(history, (turns) => [...turns, Items.userText(userText)])
      const turns = yield* Ref.get(history)
      yield* Effect.logInfo("[pipeline] history sent to LLM", {
        count: turns.length,
        messages: turns
          .filter((t): t is Items.Message => t.type === "message")
          .map((m) => ({
            role: m.role,
            text: m.content
              .map((c) => ("text" in c ? c.text : ""))
              .join("")
              .slice(0, 80),
          })),
      })

      const accumulated = yield* Ref.make("")
      const deltaCount = yield* Ref.make(0)
      const audioByteCount = yield* Ref.make(0)

      // UI sees the LLM's original text (brand names preserved); TTS sees the
      // phoneticized version (brand names rewritten for ElevenLabs Flash, which
      // doesn't support inline SSML phonemes on this model).
      const llmText = LanguageModel.streamTurn({
        history: turns,
        model: cfg.llm.model,
      }).pipe(
        Turn.textDeltas,
        Stream.tap((delta) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(deltaCount, (c) => c + 1)
            if (n === 1) yield* Effect.logInfo("[pipeline] LLM first delta", { delta })
            yield* sendStatus({ type: "assistant-delta", text: delta })
            yield* Ref.update(accumulated, (s) => s + delta)
          }),
        ),
        Stream.map(phoneticize),
      )

      const audio = SpeechSynthesizer.streamSynthesisFrom(llmText, {
        model: cfg.tts.model,
        voiceId: cfg.tts.voiceId,
        outputFormat: cfg.tts.outputFormat,
      })

      // Whatever the audio stream's exit reason (clean close, interrupt
      // during teardown, real TTS failure), commit whatever LLM text we
      // accumulated to the conversation history and tell the UI we're done.
      // Without this guarantee, an interrupt cause from the audio stream's
      // forked fibers (which can fire even on clean WS close in v4) skips
      // the post-stream code, so the assistant turn never lands in history
      // and the LLM repeats the same intro on every turn.
      const commitAssistantTurn = Effect.gen(function* () {
        const finalText = yield* Ref.get(accumulated)
        const totalDeltas = yield* Ref.get(deltaCount)
        const totalAudio = yield* Ref.get(audioByteCount)
        yield* Effect.logInfo("[pipeline] utterance complete", {
          assistantText: finalText,
          deltaCount: totalDeltas,
          audioBytes: totalAudio,
        })
        if (finalText.length > 0) {
          yield* Ref.update(history, (turns) => [...turns, Items.assistantText(finalText)])
        }
        const after = yield* Ref.get(history)
        yield* Effect.logInfo("[pipeline] history after assistant turn", {
          count: after.length,
          lastAssistantPreview: finalText.slice(0, 80),
        })
        yield* sendStatus({ type: "assistant-done", text: finalText })
      })

      yield* Stream.runForEach(audio, (chunk) =>
        Effect.gen(function* () {
          const total = yield* Ref.updateAndGet(audioByteCount, (n) => n + chunk.bytes.length)
          if (total === chunk.bytes.length) {
            yield* Effect.logInfo("[pipeline] TTS first chunk", { bytes: chunk.bytes.length })
          }
          yield* sendAudio(chunk.bytes)
        }),
      ).pipe(Effect.ensuring(commitAssistantTurn))
    }).pipe(
      Effect.tapCause((cause) =>
        // Interrupt-only causes are normal teardown (forked WS reader / writer
        // fibers tear down when the audio stream completes). Only log real
        // failures — `Effect.catchCause` downstream still routes the cause to
        // the consumer's error path either way.
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("[pipeline] utterance failed", {
              pretty: Cause.pretty(cause),
              squashed: Cause.squash(cause),
            }),
      ),
    )

// ---------------------------------------------------------------------------
// STT side — produce partial / final status events; enqueue finals for the
// consumer fiber to process.
// ---------------------------------------------------------------------------

const sttToStatus = (
  utteranceQueue: Queue.Queue<string>,
  sendStatus: (event: StatusEvent) => Effect.Effect<void>,
): ((event: TranscriptEvent) => Effect.Effect<void>) =>
  Match.type<TranscriptEvent>().pipe(
    Match.tag("partial", ({ text }) =>
      Effect.gen(function* () {
        yield* Effect.logDebug("[pipeline] stt partial", { text })
        yield* sendStatus({ type: "user-partial", text })
      }),
    ),
    Match.tag("final", ({ text }) =>
      Effect.gen(function* () {
        const trimmed = text.trim()
        // STT emits finals on VAD silence boundaries even when the user
        // didn't say anything meaningful (background noise, filler).
        // Skipping blank finals stops the LLM from being asked to respond
        // to "" and inventing something.
        if (trimmed.length === 0) {
          yield* Effect.logDebug("[pipeline] stt final (blank, skipped)")
          return
        }
        yield* Effect.logInfo("[pipeline] stt final", { text: trimmed })
        yield* sendStatus({ type: "user-final", text: trimmed })
        yield* Queue.offer(utteranceQueue, trimmed)
      }),
    ),
    Match.tag("error", ({ message }) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("[pipeline] stt error", { message })
        yield* sendStatus({ type: "error", message })
      }),
    ),
    // Other tags (`speech-started`, `utterance-ended`, `audio-event`, `metadata`)
    // are dropped — the UI doesn't surface them.
    Match.orElse((event) => Effect.logDebug("[pipeline] stt event (unhandled)", { event })),
  )

// ---------------------------------------------------------------------------
// Full pipeline. Takes the inbound mic stream and the per-direction
// emit functions; returns an Effect that runs until cancelled.
// ---------------------------------------------------------------------------

export const runPipeline = <E, R>(
  cfg: PipelineConfig,
  audioIn: Stream.Stream<Uint8Array, E, R>,
  sendStatus: (event: StatusEvent) => Effect.Effect<void>,
  sendAudio: (bytes: Uint8Array) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const history = yield* Ref.make<ReadonlyArray<Items.Item>>([
      Items.systemText(cfg.llm.systemPrompt),
    ])
    const utteranceQueue = yield* Queue.unbounded<string>()

    const handler = handleUtterance(cfg, history, sendStatus, sendAudio)

    yield* Effect.logInfo("[pipeline] starting", {
      stt: cfg.stt.model,
      llm: cfg.llm.model,
      tts: `${cfg.tts.model} / ${cfg.tts.voiceId}`,
    })

    // Consumer: serialize one utterance round-trip at a time. Each iteration
    // drains a burst of close-together `final` transcripts (STT sometimes
    // splits one sentence on a brief mid-pause) so a perceived single
    // prompt produces one LLM round-trip + one TTS response. New utterances
    // arriving while the assistant is mid-response sit on the queue.
    //
    // Errors inside one handler call are caught + reported as a status
    // event; the consumer fiber keeps running so subsequent turns still
    // work after a transient provider failure.
    yield* Effect.forever(
      drainBurst(utteranceQueue, cfg.utteranceSettle).pipe(
        Effect.tap((batch) =>
          batch.length > 1
            ? Effect.logInfo("[pipeline] coalesced burst", {
                size: batch.length,
                joined: batch.join(" "),
              })
            : Effect.void,
        ),
        Effect.flatMap((batch) =>
          batch.length === 0
            ? Effect.void
            : handler(batch.join(" ")).pipe(
                Effect.catchCause((cause) =>
                  // Interrupt-only causes are normal teardown (e.g. WS clean
                  // close at end of TTS playback) — they're not failures, so
                  // don't surface them to the UI as errors.
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : sendStatus({
                        type: "error",
                        message: `assistant turn failed: ${Cause.pretty(cause)}`,
                      }),
                ),
              ),
        ),
      ),
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("[pipeline] consumer fiber died (unexpected)", { cause }),
      ),
      Effect.forkScoped,
    )

    // Producer: live STT. Each TranscriptEvent goes to the UI; finals
    // also push into the consumer queue.
    const sttEvents = Transcriber.streamTranscriptionFrom(audioIn, {
      model: cfg.stt.model,
      inputFormat: cfg.stt.inputFormat,
      wordTimestamps: false,
    })

    yield* Stream.runForEach(sttEvents, sttToStatus(utteranceQueue, sendStatus)).pipe(
      Effect.tap(() => Effect.logInfo("[pipeline] STT stream ended")),
    )
  })
