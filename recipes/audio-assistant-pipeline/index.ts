/**
 * Voice-assistant pipeline as a clean stream chain:
 *
 *   audioIn.pipe(
 *     stt,                  // Stream<Uint8Array> → Stream<string>  (live partials → status)
 *     settleBurst,          // Stream<string>     → Stream<ReadonlyArray<string>>
 *     Stream.map(join),     //                    → Stream<string>  (one coalesced utterance)
 *     loopFrom(state, ...), //                    → Stream<AudioChunk>
 *     Stream.runForEach(sendAudio),
 *   )
 *
 * State (conversation history) lives in the `loopFrom` body via the loop's
 * own `Next<S>` transitions — no Ref shared across iterations. Status
 * events flow through a `sendStatus` callback (side-channel) because the
 * primary stream carries audio, not UI events.
 *
 * Barge-in is **not** modelled — utterances queue while the assistant is
 * speaking (`loopFrom` pulls one input per iteration). See README.
 */
import { Cause, Effect, Match, Ref, Result, Stream } from "effect"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import { type Event, next, value } from "@effect-uai/core/Loop"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as Transcriber from "@effect-uai/core/Transcriber"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import * as Turn from "@effect-uai/core/Turn"
import type * as Duration from "effect/Duration"
import { loopFrom, settleBurst } from "./streamOps.js"

// ---------------------------------------------------------------------------
// Wire shapes & config
// ---------------------------------------------------------------------------

export type StatusEvent =
  | { readonly type: "user-partial"; readonly text: string }
  | { readonly type: "user-final"; readonly text: string }
  | { readonly type: "assistant-thinking" }
  | { readonly type: "assistant-delta"; readonly text: string }
  | { readonly type: "assistant-done"; readonly text: string }
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
// Stage 1 — STT: Stream<Uint8Array> → Stream<string>
// Emits live partial / error events as side-effects via `sendStatus`;
// passes through trimmed non-empty finals as stream values.
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
          // Finals are surfaced as stream values below; other tags ignored.
          Match.orElse(() => Effect.void),
        ),
      ),
      Stream.filterMap((event) =>
        event._tag === "final" && event.text.trim().length > 0
          ? Result.succeed(event.text.trim())
          : Result.failVoid,
      ),
    )

// ---------------------------------------------------------------------------
// Stage 2 — Conversation turn: (state, userText) → Stream<Event<AudioChunk, State>>
// The loopFrom body. One iteration per coalesced user utterance.
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.Item>
}

const conversationTurn =
  (cfg: PipelineConfig, sendStatus: SendStatus) =>
  (state: State, userText: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.logInfo("[pipeline] processing utterance", { userText })
        yield* sendStatus({ type: "user-final", text: userText })
        yield* sendStatus({ type: "assistant-thinking" })

        const history = [...state.history, Items.userText(userText)]
        const acc = yield* Ref.make("")
        const deltaCount = yield* Ref.make(0)

        const audio = LanguageModel.streamTurn({ history, model: cfg.llm.model }).pipe(
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

        // Emit audio chunks as Value events; on stream end, send the
        // assistant-done status and transition state with the new history.
        return audio.pipe(
          Stream.map(
            (chunk): Event<AudioChunk, State> => value(chunk as AudioChunk),
          ),
          Stream.concat(
            Stream.fromEffect(
              Effect.gen(function* () {
                const text = yield* Ref.get(acc)
                yield* Effect.logInfo("[pipeline] utterance complete", { text })
                yield* sendStatus({ type: "assistant-done", text })
                const newHistory =
                  text.length > 0 ? [...history, Items.assistantText(text)] : history
                return next({ history: newHistory } as State)
              }),
            ),
          ),
        )
      }),
    )

// ---------------------------------------------------------------------------
// Compose
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

    const initialState: State = {
      history: [Items.systemText(cfg.llm.systemPrompt)],
    }

    yield* audioIn.pipe(
      stt(cfg, sendStatus),
      // Resetting-window debounce: every new STT final resets the timer.
      // Only when `utteranceSettle` ms pass with no new arrivals does the
      // buffered batch flow downstream, ensuring "Hello, what's the weather"
      // arriving as two finals coalesces into one LLM call.
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
      loopFrom(initialState, conversationTurn(cfg, sendStatus)),
      Stream.runForEach((chunk) => sendAudio(chunk.bytes)),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("[pipeline] terminated", { cause: Cause.pretty(cause) }),
      ),
    )
  })
