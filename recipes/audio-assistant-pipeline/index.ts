/**
 * Voice-assistant pipeline as three concurrent units, not a single stream pipe:
 *
 *   1. `stt` events → shared once, fanned out as (a) `finals` and (b) `bargeIn`
 *   2. Barge-in watcher: on real-speech partial, `Fiber.interrupt(activeTurn)`
 *   3. Utterance loop: `finals → settleBurst → fork(runAssistantTurn)`
 *
 * Each user utterance runs in its own fiber that does LLM → TTS → paced send.
 * Barge-in is a plain `Fiber.interrupt`, which interrupts the fiber wherever
 * it happens to be (mid-LLM-pull, mid-TTS, mid-pacing-`Effect.sleep`). The
 * fiber's `onInterrupt` handler commits whatever was spoken so far.
 *
 * History lives in a top-level `Ref` rather than being threaded through a
 * stream-state combinator — simpler, and `onInterrupt` can append a partial
 * assistant message without reaching into stream internals.
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
      "enthusiastic; no exclamations like \"Oh!\" or \"Alright!\". Just answer.",
      "",
      "The user is a single person continuing one conversation. Don't role-play",
      "or adopt personas based on how they phrase things — if they say",
      "\"this is the manager,\" they're just talking, not introducing a character.",
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

// ---------------------------------------------------------------------------
// Audio pacing — bytes / (sampleRate * 2 * channels) seconds for s16le.
// The pacing sleep inside the per-chunk loop is what keeps the assistant
// fiber alive while the browser is still playing audio: as long as that
// fiber is alive, a barge-in `Fiber.interrupt` can cleanly cut it short.
// ---------------------------------------------------------------------------

const chunkDurationMs = (bytes: number, format: AudioFormat): number =>
  (bytes / (format.sampleRate * 2 * (format.channels ?? 1))) * 1000

// ---------------------------------------------------------------------------
// STT: Stream<Uint8Array> → Stream<TranscriptEvent>
//
// Side-effects for partials / errors flow through `Stream.tap`; downstream
// consumers split this stream into finals (→ settleBurst → utterance loop)
// and partials (→ barge-in trigger).
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
            Effect.gen(function* () {
              yield* Effect.logDebug("[pipeline] stt partial", { text })
              yield* sendStatus({ type: "user-partial", text })
            }),
          ),
          Match.tag("error", ({ message }) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("[pipeline] stt error", { message })
              yield* sendStatus({ type: "error", message })
            }),
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
// as a substring. Fires the interrupt watcher. Note: "stopping" contains
// "stop", so it would also trigger — accepted edge case in exchange for
// dead-simple matching.
//
// `isJustStopWord` — true if the normalized final IS exactly a stop word.
// These are dropped from the utterance loop so we don't spawn a turn for a
// bare control command. Finals like "Stop. Tell me about chemistry" still
// flow through the utterance loop intact, so the follow-up question runs
// as the next turn after the current one is cut.
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
  return STOP_WORDS.some((word) => t.includes(word))
}

const isJustStopWord = (text: string): boolean => {
  const t = normalizeFinal(text)
  return STOP_WORDS.includes(t)
}

// ---------------------------------------------------------------------------
// runAssistantTurn — one user utterance → one assistant response.
// Top-to-bottom Effect: status → LLM stream → pace and send → commit history.
// On `Fiber.interrupt`, the `onInterrupt` handler commits whatever was spoken
// so far (no editorial marker — letting the model see a clean truncated
// response avoids it drifting into role-play on the next turn).
// ---------------------------------------------------------------------------

const runAssistantTurn = (
  cfg: PipelineConfig,
  sendStatus: SendStatus,
  sendAudio: (bytes: Uint8Array) => Effect.Effect<void>,
  historyRef: Ref.Ref<ReadonlyArray<Items.Item>>,
  userText: string,
) =>
  // Outer gen owns `acc` so the inner gen's `onInterrupt` handler can read it.
  // (`.pipe(Effect.onInterrupt(...))` runs OUTSIDE the inner generator's scope,
  // so anything declared with `yield* Ref.make(...)` inside it isn't visible
  // from the interrupt handler.)
  Effect.gen(function* () {
    const acc = yield* Ref.make("")

    yield* Effect.gen(function* () {
      yield* Effect.logInfo("[pipeline] processing utterance", { userText })
      yield* sendStatus({ type: "user-final", text: userText })
      yield* sendStatus({ type: "assistant-thinking" })

      const history = yield* Ref.get(historyRef)
      const turnHistory = [...history, Items.userText(userText)]
      const deltaCount = yield* Ref.make(0)

      const audio = LanguageModel.streamTurn({ history: turnHistory, model: cfg.llm.model }).pipe(
        Turn.textDeltas,
        Stream.tap((delta) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(deltaCount, (c) => c + 1)
            if (n === 1) yield* Effect.logInfo("[pipeline] LLM first delta", { delta })
            yield* sendStatus({ type: "assistant-delta", text: delta })
            yield* Ref.update(acc, (s) => s + delta)
          }),
        ),
        Stream.map(phoneticize),
        SpeechSynthesizer.streamSynthesisFrom({
          model: cfg.tts.model,
          voiceId: cfg.tts.voiceId,
          outputFormat: cfg.tts.outputFormat,
        }),
      )

      // Pace browser-bound chunks to playback rate. `Stream.runForEach` pulls
      // one chunk, sends it, sleeps for the chunk's playback duration, then
      // pulls the next. `Fiber.interrupt` from the barge-in watcher can land
      // anywhere — mid-pull, mid-sendAudio, mid-sleep — and the loop dies.
      yield* Stream.runForEach(audio, (chunk: AudioChunk) =>
        Effect.gen(function* () {
          yield* sendAudio(chunk.bytes)
          const dur = chunkDurationMs(chunk.bytes.length, cfg.tts.outputFormat)
          if (dur >= 1) yield* Effect.sleep(`${Math.floor(dur)} millis`)
        }),
      )

      // Natural completion → commit the full turn.
      const text = yield* Ref.get(acc)
      yield* Effect.logInfo("[pipeline] utterance complete", { text })
      yield* sendStatus({ type: "assistant-done", text })
      yield* Ref.update(historyRef, (h) =>
        text.length > 0
          ? [...h, Items.userText(userText), Items.assistantText(text)]
          : [...h, Items.userText(userText)],
      )
    }).pipe(
      // Interrupted by barge-in → commit whatever was actually spoken.
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          const text = yield* Ref.get(acc)
          yield* Effect.logInfo("[pipeline] utterance cancelled", { text })
          yield* sendStatus({ type: "assistant-cancelled", text })
          yield* Ref.update(historyRef, (h) =>
            text.length > 0
              ? [...h, Items.userText(userText), Items.assistantText(text)]
              : [...h, Items.userText(userText)],
          )
        }),
      ),
    )
  })

// ---------------------------------------------------------------------------
// runPipeline — three concurrent units:
//   (1) STT shared, fanned to finals + bargeIn
//   (2) Barge-in watcher: real partial → Fiber.interrupt(activeTurn)
//   (3) Utterance loop: finals → settleBurst → fork(runAssistantTurn)
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

    // Pipeline-level state.
    const historyRef = yield* Ref.make<ReadonlyArray<Items.Item>>([
      Items.systemText(cfg.llm.systemPrompt),
    ])
    const activeTurn = yield* Ref.make<Fiber.Fiber<void, AiError.AiError> | null>(null)

    // Share STT events so the stop-word watcher and the utterance loop can
    // both read finals independently. (Subscribers only see events emitted
    // AFTER they subscribe — stale partials never reach a new subscriber.)
    const sttEvents = yield* audioIn.pipe(stt(cfg, sendStatus), Stream.share({ capacity: 32 }))
    const finals = sttEvents.pipe(Stream.filterMap(finalTextOf))

    // (1) Stop-word watcher. Reads RAW finals (no settleBurst) so a
    // deliberate "Stop." interrupts as soon as STT delivers the final.
    // Matches stop words at word boundaries — "Stop." fires, "Stop. Tell
    // me about chemistry." also fires (and the chemistry part still flows
    // to the utterance loop below as the next queued turn). "Stopping"
    // wouldn't match. No user-final status is sent here — the turn fiber
    // will send its own user-final when the queued utterance runs; for
    // bare "Stop." the audio going quiet is the feedback.
    yield* finals.pipe(
      Stream.filter(containsStopWord),
      Stream.runForEach((text) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("[pipeline] stop word", { text })
          const fiber = yield* Ref.get(activeTurn)
          if (fiber !== null) yield* Fiber.interrupt(fiber)
        }),
      ),
      Effect.forkScoped,
    )

    // (2) Utterance loop. Drops finals that are JUST a stop word ("Stop.")
    // so they don't become a turn — but keeps "Stop. Tell me about
    // chemistry." (substantive content remains, LLM gracefully absorbs the
    // leading "Stop"). Everything else feeds settleBurst → one turn per
    // coalesced burst.
    //
    // Turns are awaited sequentially inside `Stream.runForEach`, so a
    // follow-up question spoken while the assistant is still answering
    // doesn't interrupt — it sits in settleBurst's buffer and runs as soon
    // as the current turn naturally completes. Nothing is lost.
    yield* finals.pipe(
      Stream.filter((text) => !isJustStopWord(text)),
      settleBurst(cfg.utteranceSettle),
      Stream.tap((batch: ReadonlyArray<string>) =>
        batch.length > 1
          ? Effect.logInfo("[pipeline] coalesced burst", {
              size: batch.length,
              joined: batch.join(" "),
            })
          : Effect.void,
      ),
      Stream.map((batch: ReadonlyArray<string>) => batch.join(" ")),
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
