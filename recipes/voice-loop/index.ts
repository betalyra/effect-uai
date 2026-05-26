/**
 * Voice-assistant pipeline. Two concurrent units share an STT stream:
 *
 *   (1) Stop-word watcher — raw finals → `Fiber.interrupt(activeTurn)` on any
 *       final containing a stop word ("stop", "wait", …).
 *   (2) Utterance loop    — finals → settleBurst → fork one `runAssistantTurn`
 *       fiber per coalesced utterance, awaited sequentially.
 *
 * Each user utterance runs in its own fiber: LLM → TTS → paced send. The
 * pacing `Effect.sleep` keeps the fiber alive for the duration the user is
 * hearing audio, so `Fiber.interrupt` cleanly aborts wherever it lands
 * (mid-LLM, mid-TTS, mid-sleep). The fiber's `Effect.onInterrupt` handler
 * commits whatever was spoken so far.
 *
 * Follow-up utterances spoken during an active turn don't interrupt — they
 * sit in settleBurst's buffer and run as the next turn once the current one
 * finishes naturally.
 *
 * History lives in a top-level `Ref` rather than being threaded through a
 * stream-state combinator — simpler, and the interrupt handler can append a
 * partial assistant message without reaching into stream internals.
 */
import { Cause, Effect, Fiber, Match, Ref, Result, Stream } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as Transcriber from "@effect-uai/core/Transcriber"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import * as Turn from "@effect-uai/core/Turn"
import type * as Duration from "effect/Duration"
import { settleBurst } from "./streamOps.js"

// ---------------------------------------------------------------------------
// Wire shapes & config
// ---------------------------------------------------------------------------

export type StatusEvent =
  | { readonly type: "user-partial"; readonly text: string }
  | { readonly type: "user-final"; readonly text: string }
  | { readonly type: "assistant-thinking" }
  | { readonly type: "assistant-delta"; readonly text: string }
  | { readonly type: "assistant-done"; readonly text: string }
  | { readonly type: "assistant-cancelled"; readonly text: string }
  | { readonly type: "error"; readonly message: string }

export type PipelineConfig = {
  readonly stt: { readonly model: string; readonly inputFormat: AudioFormat }
  readonly llm: { readonly model: string; readonly systemPrompt: string }
  readonly tts: {
    readonly model: string
    readonly voiceId: string
    readonly outputFormat: AudioFormat
  }
  /** Resetting-window debounce for coalescing rapid STT finals. */
  readonly utteranceSettle: Duration.Input
}

export const defaultConfig: PipelineConfig = {
  stt: {
    model: "scribe_v2_realtime",
    inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  },
  llm: {
    model: "gemini-2.5-flash",
    systemPrompt: [
      // Always write the brand name as `effect-uai`. A server-side phonetic
      // rewrite (`effect-uai` → `effect why`) handles pronunciation before
      // text hits the TTS engine, so the UI still shows the proper name.
      "You are a conversational voice assistant. Speak naturally and directly.",
      "You're happy to discuss any topic — explain things, brainstorm, banter",
      "lightly when it fits. Don't be performative, theatrical, or overly",
      'enthusiastic; no exclamations like "Oh!" or "Alright!". Just answer.',
      "",
      "The user is a single person continuing one conversation. Don't role-play",
      "or adopt personas based on how they phrase things — if they say",
      '"this is the manager," they\'re just talking, not introducing a character.',
      "",
      "Background (only if asked who or what you are):",
      "- You're powered by effect-uai, a TypeScript library built on Effect for",
      "  writing AI applications by composing small primitives instead of",
      "  configuring a framework.",
      "",
      "Voice-output rules:",
      "- One or two short sentences per turn. No lists, code, or markdown.",
      "- Always write the brand name as `effect-uai` (with the hyphen).",
      "- Never refuse a question as off-topic. If you don't know, say so briefly",
      "  and offer what you do know.",
    ].join("\n"),
  },
  tts: {
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 48000, channels: 1 },
  },
  utteranceSettle: "350 millis",
}

// ---------------------------------------------------------------------------
// Phonetic / markdown rewrites applied just before the TTS WS. UI sees the
// LLM's original text; only the speech engine sees these substitutions.
// ---------------------------------------------------------------------------

const TTS_REWRITES: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  [/effect-uai/gi, "effect why"],
  [/[`*_]/g, ""],
]

const phoneticize = (text: string): string =>
  TTS_REWRITES.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), text)

// Real-time duration of an s16le PCM chunk. The pacing sleep based on this
// duration keeps the assistant fiber alive while the browser plays audio,
// so a stop-word `Fiber.interrupt` can cut it short mid-response.
const chunkDurationMs = (bytes: number, format: AudioFormat): number =>
  (bytes / (format.sampleRate * 2 * (format.channels ?? 1))) * 1000

// ---------------------------------------------------------------------------
// STT: side-effects (partial / error → status) flow through `Stream.tap`;
// downstream consumers split this into finals via `finalTextOf`.
// ---------------------------------------------------------------------------

type SendStatus = (event: StatusEvent) => Effect.Effect<void>

const stt =
  (cfg: PipelineConfig, sendStatus: SendStatus) =>
  <E, R>(audioIn: Stream.Stream<Uint8Array, E, R>) =>
    audioIn.pipe(
      Transcriber.streamTranscriptionFrom({
        model: cfg.stt.model,
        inputFormat: cfg.stt.inputFormat,
        wordTimestamps: false,
      }),
      Stream.tap(
        Match.type<TranscriptEvent>().pipe(
          Match.tag("partial", ({ text }) =>
            Effect.logDebug("[pipeline] stt partial", { text }).pipe(
              Effect.andThen(sendStatus({ type: "user-partial", text })),
            ),
          ),
          Match.tag("error", ({ message }) =>
            Effect.logWarning("[pipeline] stt error", { message }).pipe(
              Effect.andThen(sendStatus({ type: "error", message })),
            ),
          ),
          Match.orElse(() => Effect.void),
        ),
      ),
    )

const finalTextOf = (event: TranscriptEvent) =>
  event._tag === "final" && event.text.trim().length > 0
    ? Result.succeed(event.text.trim())
    : Result.failVoid

// ---------------------------------------------------------------------------
// Stop-word classifier.
//
// `containsStopWord` — true if the normalized final contains any stop word
// as a substring. Fires the interrupt watcher. (Substring match is brittle
// — "stopping" contains "stop" — but easy to read; we accept the false
// positives for demo simplicity.)
//
// `isJustStopWord` — true if the normalized final IS exactly a stop word.
// These are dropped from the utterance loop so "Stop." doesn't spawn a
// turn. Finals like "Stop. Tell me about chemistry" still flow through
// intact, so the follow-up question runs as the next turn after the cut.
// ---------------------------------------------------------------------------

const STOP_WORDS: ReadonlyArray<string> = [
  "stop",
  "wait",
  "pause",
  "hold on",
  "shut up",
  "be quiet",
]

const normalizeFinal = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:…]/g, "")
    .replace(/\s+/g, " ")
    .trim()

const containsStopWord = (text: string): boolean => {
  const t = normalizeFinal(text)
  return STOP_WORDS.some((w) => t.includes(w))
}

const isJustStopWord = (text: string): boolean => STOP_WORDS.includes(normalizeFinal(text))

// ---------------------------------------------------------------------------
// runAssistantTurn — one user utterance → one assistant response.
//
// Linear top-to-bottom: status events → build audio stream → drain it with
// per-chunk pacing → commit to history. `commit` handles both natural
// completion (`Effect.tap` on success) and interruption (`Effect.onInterrupt`),
// reading the same `acc` Ref so the assistant's partial text is preserved
// either way.
// ---------------------------------------------------------------------------

const runAssistantTurn = (
  cfg: PipelineConfig,
  sendStatus: SendStatus,
  sendAudio: (bytes: Uint8Array) => Effect.Effect<void>,
  historyRef: Ref.Ref<ReadonlyArray<Items.HistoryItem>>,
  userText: string,
) =>
  Effect.gen(function* () {
    const acc = yield* Ref.make("")

    // Append the user turn (plus the assistant's accumulated text, if any)
    // to history and send the terminal status. Closed over `acc` so success
    // and interrupt paths share one definition.
    const commit = (type: "assistant-done" | "assistant-cancelled") =>
      Effect.gen(function* () {
        const text = yield* Ref.get(acc)
        yield* Effect.logInfo(`[pipeline] ${type}`, { text })
        yield* sendStatus({ type, text })
        yield* Ref.update(historyRef, (h) => [
          ...h,
          Items.userText(userText),
          ...(text.length > 0 ? [Items.assistantText(text)] : []),
        ])
      })

    yield* sendStatus({ type: "user-final", text: userText })
    yield* sendStatus({ type: "assistant-thinking" })

    const history = yield* Ref.get(historyRef)
    const audio = LanguageModel.streamTurn({
      history: [...history, Items.userText(userText)],
      model: cfg.llm.model,
    }).pipe(
      Turn.textDeltas,
      Stream.tap((delta) =>
        sendStatus({ type: "assistant-delta", text: delta }).pipe(
          Effect.andThen(Ref.update(acc, (s) => s + delta)),
        ),
      ),
      Stream.map(phoneticize),
      SpeechSynthesizer.streamSynthesisFrom({
        model: cfg.tts.model,
        voiceId: cfg.tts.voiceId,
        outputFormat: cfg.tts.outputFormat,
      }),
    )

    // Send each chunk, then sleep its playback duration. The sleep is what
    // keeps this fiber alive for the full time the user is hearing audio,
    // so `Fiber.interrupt` from the stop-word watcher lands while we're
    // still here and cleanly tears the loop down.
    yield* Stream.runForEach(audio, (chunk: AudioChunk) =>
      sendAudio(chunk.bytes).pipe(
        Effect.andThen(
          Effect.sleep(
            `${Math.max(1, Math.floor(chunkDurationMs(chunk.bytes.length, cfg.tts.outputFormat)))} millis`,
          ),
        ),
      ),
    ).pipe(
      Effect.tap(() => commit("assistant-done")),
      Effect.onInterrupt(() => commit("assistant-cancelled")),
    )
  })

// ---------------------------------------------------------------------------
// runPipeline — wires STT → stop-word watcher + utterance loop.
// ---------------------------------------------------------------------------

export const runPipeline = <E, R>(
  cfg: PipelineConfig,
  audioIn: Stream.Stream<Uint8Array, E, R>,
  sendStatus: SendStatus,
  sendAudio: (bytes: Uint8Array) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[pipeline] starting", {
      stt: cfg.stt.model,
      llm: cfg.llm.model,
      tts: `${cfg.tts.model} / ${cfg.tts.voiceId}`,
    })

    const historyRef = yield* Ref.make<ReadonlyArray<Items.HistoryItem>>([
      Items.systemText(cfg.llm.systemPrompt),
    ])
    const activeTurn = yield* Ref.make<Fiber.Fiber<void, AiError.AiError> | null>(null)

    // Share the STT stream so the stop-word watcher and the utterance loop
    // can both pull finals independently. Subscribers only see events
    // emitted after they subscribe — stale partials don't reach a new sub.
    const sttEvents = yield* audioIn.pipe(stt(cfg, sendStatus), Stream.share({ capacity: 32 }))
    const finals = sttEvents.pipe(Stream.filterMap(finalTextOf))

    // (1) Stop-word watcher. Reads raw finals (no settleBurst) so "Stop."
    // interrupts as soon as STT delivers the final.
    yield* finals.pipe(
      Stream.filter(containsStopWord),
      Stream.runForEach((text) =>
        Effect.logInfo("[pipeline] stop word", { text }).pipe(
          Effect.andThen(Ref.get(activeTurn)),
          Effect.flatMap((fiber) => (fiber !== null ? Fiber.interrupt(fiber) : Effect.void)),
        ),
      ),
      Effect.forkScoped,
    )

    // (2) Utterance loop. Drops "Stop." alone (the watcher handled it), keeps
    // "Stop. <follow-up>" as a normal turn. Turns are awaited sequentially:
    // a follow-up spoken mid-turn sits in settleBurst's buffer and runs as
    // soon as the current turn finishes — nothing is lost.
    yield* finals.pipe(
      Stream.filter((text) => !isJustStopWord(text)),
      settleBurst(cfg.utteranceSettle),
      Stream.tap((batch) =>
        batch.length > 1
          ? Effect.logInfo("[pipeline] coalesced burst", {
              size: batch.length,
              joined: batch.join(" "),
            })
          : Effect.void,
      ),
      Stream.map((batch) => batch.join(" ")),
      Stream.runForEach((userText) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            runAssistantTurn(cfg, sendStatus, sendAudio, historyRef, userText),
          )
          yield* Ref.set(activeTurn, fiber)
          yield* Fiber.await(fiber)
          yield* Ref.set(activeTurn, null)
        }),
      ),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("[pipeline] terminated", { cause: Cause.pretty(cause) }),
      ),
    )
  })
