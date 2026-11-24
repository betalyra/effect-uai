/**
 * Voice-assistant pipeline. Two concurrent units share an STT stream:
 *
 *   (1) Stop-word watcher: raw finals → `FiberHandle.clear(activeTurn)` on any
 *       final containing a stop word ("stop", "wait", …).
 *   (2) Utterance loop: finals → settleBurst → run one `runAssistantTurn`
 *       fiber per coalesced utterance in `activeTurn`, awaited sequentially.
 *
 * Each user utterance runs in its own fiber: LLM → TTS → paced send. The
 * pacing `Effect.sleep` keeps the fiber alive for the duration the user is
 * hearing audio, so `Fiber.interrupt` cleanly aborts wherever it lands
 * (mid-LLM, mid-TTS, mid-sleep). The fiber's `Effect.onInterrupt` handler
 * commits whatever was spoken so far.
 *
 * Follow-up utterances spoken during an active turn don't interrupt: they
 * sit in settleBurst's buffer and run as the next turn once the current one
 * finishes naturally.
 *
 * Everything the browser sees goes out through `emit` as `@effect-uai/ui`
 * frames: the user's speech as transcript entries, each reply as a run with
 * its own audio channel, the audio itself as media. Provider selection,
 * config presets and the server live in `app.ts`.
 */
import { Cause, Duration, Effect, Fiber, FiberHandle, Ref, Result, Stream } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as Pcm from "@effect-uai/core/Pcm"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as Transcriber from "@effect-uai/core/Transcriber"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import * as Turn from "@effect-uai/core/Turn"
import * as Frame from "@effect-uai/ui/Frame"
import * as Projection from "@effect-uai/ui/Projection"
import type * as Run from "@effect-uai/ui/Run"
import { PROTOCOL_VERSION, RunId, type RunEvent } from "@effect-uai/ui/RunEvent"
import { settleBurst } from "@effect-uai/core/Settle"
import { MIC, SPEAKER } from "./contract.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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

/** Where every frame for the browser goes. */
export type Emit = (frame: Frame.Frame<Run.Owned>) => Effect.Effect<void>

const event =
  (emit: Emit, runId?: RunId) =>
  (e: RunEvent): Effect.Effect<void> =>
    emit(Frame.message(runId === undefined ? { event: e } : { runId, event: e }))

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

// Bytes per audio sample for a raw PCM encoding.
const bytesPerSample = (encoding: AudioFormat["encoding"]): number =>
  encoding === "pcm_f32le" ? 4 : 2

// Real-time duration of a raw PCM chunk. The pacing sleep based on this
// duration keeps the assistant fiber alive while the browser plays audio,
// so a stop-word `Fiber.interrupt` can cut it short mid-response.
const chunkDurationMs = (bytes: number, format: AudioFormat): number =>
  (bytes / (format.sampleRate * bytesPerSample(format.encoding) * (format.channels ?? 1))) * 1000

/** The browser plays 16-bit PCM; Voxtral TTS speaks 32-bit float. */
const toPlayback = (format: AudioFormat) => (bytes: Uint8Array) =>
  format.encoding === "pcm_f32le" ? Pcm.f32leToS16le(bytes) : bytes

// ---------------------------------------------------------------------------
// STT: the user's speech becomes transcript entries; errors become a problem.
// Downstream consumers split this into finals via `finalTextOf`.
// ---------------------------------------------------------------------------

const utterances = Projection.transcriptStep("transcript")

const stt =
  (cfg: PipelineConfig, emit: Emit, utterance: Ref.Ref<number>) =>
  <E, R>(audioIn: Stream.Stream<Uint8Array, E, R>) =>
    audioIn.pipe(
      Transcriber.streamTranscriptionFrom({
        model: cfg.stt.model,
        inputFormat: cfg.stt.inputFormat,
        wordTimestamps: false,
      }),
      Stream.tap((e) =>
        e._tag === "error"
          ? Effect.logWarning("[pipeline] stt error", { message: e.message }).pipe(
              Effect.andThen(event(emit)({ type: "live", name: "problem", value: e.message })),
            )
          : Ref.modify(utterance, (n) => {
              const [next, events] = utterances(n, e)
              return [events, next] as const
            }).pipe(
              Effect.flatMap((events) => Effect.forEach(events, event(emit), { discard: true })),
            ),
      ),
    )

const finalTextOf = (e: TranscriptEvent) =>
  e._tag === "final" && e.text.trim().length > 0 ? Result.succeed(e.text.trim()) : Result.failVoid

// ---------------------------------------------------------------------------
// Stop-word classifier.
//
// `containsStopWord`: true if the normalized final contains any stop word
// as a substring. Fires the interrupt watcher. (Substring match is brittle,
// "stopping" contains "stop", but easy to read; we accept the false
// positives for demo simplicity.)
//
// `isJustStopWord`: true if the normalized final IS exactly a stop word.
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
// runAssistantTurn: one user utterance → one assistant run.
//
// The run opens with what the user said and the reply's audio channel, then
// streams text and paced audio. It ends `run-completed` when the reply is
// spoken, or `run-stopped { reason: "stop-word" }` when interrupted, which
// closes the channel so the browser drops the audio it still has queued.
// Either way the spoken text is committed to history.
// ---------------------------------------------------------------------------

const runAssistantTurn = (
  cfg: PipelineConfig,
  emit: Emit,
  historyRef: Ref.Ref<ReadonlyArray<Items.HistoryItem>>,
  runId: RunId,
  userText: string,
) =>
  Effect.gen(function* () {
    const send = event(emit, runId)
    const acc = yield* Ref.make("")
    const playback = toPlayback(cfg.tts.outputFormat)

    const commit = (terminal: RunEvent) =>
      Effect.gen(function* () {
        const text = yield* Ref.get(acc)
        yield* Effect.logInfo(`[pipeline] ${terminal.type}`, { text })
        yield* send(terminal)
        yield* Ref.update(historyRef, (h) => [
          ...h,
          Items.userText(userText),
          ...(text.length > 0 ? [Items.assistantText(text)] : []),
        ])
      })

    yield* send({
      type: "run-started",
      runId,
      name: "assistant",
      inputs: [],
      protocol: PROTOCOL_VERSION,
    })
    yield* send({ type: "data", name: "prompt", value: userText })
    yield* send({
      type: "channel-opened",
      channel: SPEAKER,
      direction: "down",
      mimeType: "audio/pcm",
      sampleRate: cfg.tts.outputFormat.sampleRate,
      channels: cfg.tts.outputFormat.channels ?? 1,
    })

    const history = yield* Ref.get(historyRef)
    const audio = LanguageModel.streamTurn({
      history: [...history, Items.userText(userText)],
      model: cfg.llm.model,
    }).pipe(
      Turn.textDeltas,
      Stream.tap((delta) =>
        send({ type: "text-delta", text: delta }).pipe(
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
      emit(Frame.media(SPEAKER, playback(chunk.bytes))).pipe(
        Effect.andThen(
          Effect.sleep(
            Duration.millis(
              Math.max(1, Math.floor(chunkDurationMs(chunk.bytes.length, cfg.tts.outputFormat))),
            ),
          ),
        ),
      ),
    ).pipe(
      Effect.tap(() => commit({ type: "run-completed" })),
      Effect.onInterrupt(() => commit({ type: "run-stopped", reason: "stop-word" })),
    )
  })

// ---------------------------------------------------------------------------
// runPipeline: declares the mic, then wires STT → stop-word watcher + utterance loop.
// ---------------------------------------------------------------------------

export const runPipeline = <E, R>(
  cfg: PipelineConfig,
  audioIn: Stream.Stream<Uint8Array, E, R>,
  emit: Emit,
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[pipeline] starting", {
      stt: cfg.stt.model,
      llm: cfg.llm.model,
      tts: `${cfg.tts.model} / ${cfg.tts.voiceId}`,
    })

    // The mic format the transcriber takes, so the browser records at it.
    yield* event(emit)({
      type: "channel-opened",
      channel: MIC,
      direction: "up",
      mimeType: "audio/pcm",
      sampleRate: cfg.stt.inputFormat.sampleRate,
      channels: 1,
    })

    const historyRef = yield* Ref.make<ReadonlyArray<Items.HistoryItem>>([
      Items.systemText(cfg.llm.systemPrompt),
    ])
    // The turn being spoken; it leaves the handle when it ends.
    const activeTurn = yield* FiberHandle.make<void, AiError.AiError>()
    const utterance = yield* Ref.make(0)

    // Share the STT stream so the stop-word watcher and the utterance loop
    // can both pull finals independently. Subscribers only see events
    // emitted after they subscribe, so stale partials don't reach a new sub.
    const sttEvents = yield* audioIn.pipe(stt(cfg, emit, utterance), Stream.share({ capacity: 32 }))
    const finals = sttEvents.pipe(Stream.filterMap(finalTextOf))

    // (1) Stop-word watcher. Reads raw finals (no settleBurst) so "Stop."
    // interrupts as soon as STT delivers the final.
    yield* finals.pipe(
      Stream.filter(containsStopWord),
      Stream.runForEach((text) =>
        Effect.logInfo("[pipeline] stop word", { text }).pipe(
          Effect.andThen(FiberHandle.clear(activeTurn)),
        ),
      ),
      Effect.forkScoped,
    )

    // (2) Utterance loop. Drops "Stop." alone (the watcher handled it), keeps
    // "Stop. <follow-up>" as a normal turn. Turns are awaited sequentially:
    // a follow-up spoken mid-turn sits in settleBurst's buffer and runs as
    // soon as the current turn finishes, so nothing is lost.
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
      Stream.zipWithIndex,
      Stream.runForEach(([userText, n]) =>
        FiberHandle.run(
          activeTurn,
          runAssistantTurn(cfg, emit, historyRef, RunId.make(`turn-${n}`), userText),
        ).pipe(Effect.flatMap(Fiber.await)),
      ),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("[pipeline] terminated", { cause: Cause.pretty(cause) }),
      ),
    )
  })
