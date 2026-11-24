/**
 * Pipe a Stream of text deltas through the generic
 * `SpeechSynthesizer.streamSynthesisFrom` capability. Provider-agnostic at
 * the call site: `app.ts` picks the Layer, this file the matching request
 * shape. Adding a provider is one `Match.when` here and one name in `app.ts`.
 *
 * `speechSession` is the live session around it: lines typed in the
 * browser go into one open synthesis session, each becomes a `line` entry,
 * and the speech comes back as media frames on one channel.
 */
import { type Cause, Effect, Match, Queue, Result, Stream } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as Frame from "@effect-uai/ui/Frame"
import type * as Run from "@effect-uai/ui/Run"
import { SPEAKER, type Say, SynthesisUi } from "./contract.js"

export type Provider = "elevenlabs" | "inworld"

/**
 * PCM s16le at 48 kHz mono, the native rate of most browser
 * `AudioContext`s, so no resampling is needed in the worklet.
 */
const outputFormat = {
  container: "raw",
  encoding: "pcm_s16le",
  sampleRate: 48000,
  channels: 1,
} satisfies AudioFormat

/** Per-provider model + voice. */
export const providerConfig: (provider: Provider) => {
  readonly model: string
  readonly voiceId: string
} = Match.type<Provider>().pipe(
  Match.when("elevenlabs", () => ({
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
  })),
  Match.when("inworld", () => ({
    model: "inworld-tts-2",
    voiceId: "Sarah",
  })),
  Match.exhaustive,
)

export const synthesizeText = (provider: Provider) =>
  SpeechSynthesizer.streamSynthesisFrom({
    ...providerConfig(provider),
    outputFormat,
  })

// ---------------------------------------------------------------------------
// The live session
// ---------------------------------------------------------------------------

/**
 * One line goes upstream as a single frame, so the provider sees one
 * generation unit: smoother prosody, no per-word seams. The trailing
 * terminator nudges it to flush promptly rather than wait for more text.
 */
const TERMINATED = /[.!?]\s*$/

// A `Filter` for `Stream.filterMap`: a typed line, or nothing to say.
const submission = (frame: Frame.Frame<Say>): Result.Result<string, Frame.Frame<Say>> => {
  const trimmed = frame._tag === "Message" ? frame.message.text.trim() : ""
  if (trimmed.length === 0) return Result.fail(frame)
  return Result.succeed(TERMINATED.test(trimmed) ? `${trimmed} ` : `${trimmed}. `)
}

const speaker: Frame.Frame<Run.Owned> = Frame.message({
  event: {
    type: "channel-opened",
    channel: SPEAKER,
    direction: "down",
    mimeType: "audio/pcm",
    sampleRate: outputFormat.sampleRate,
    channels: outputFormat.channels,
  },
})

const entry = (effect: Effect.Effect<Run.Owned["event"], unknown>) =>
  // Our own values, so an encoding failure is a bug.
  Effect.map(Effect.orDie(effect), (event) => Frame.message<Run.Owned>({ event }))

/**
 * Lines typed in the browser, spoken through one open synthesis session.
 * Each accepted line becomes a `line` entry; the speech follows as media on
 * `SPEAKER`. A synthesizer failure ends the speech with a `problem`.
 */
export const speechSession = (provider: Provider) => (up: Stream.Stream<Frame.Frame<Say>>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const text = yield* Queue.unbounded<string, Cause.Done>()
      const lines = up.pipe(
        Stream.filterMap(submission),
        Stream.tap((line) => Queue.offer(text, line)),
        Stream.ensuring(Queue.end(text)),
        Stream.zipWithIndex,
        Stream.mapEffect(([line, n]) =>
          entry(SynthesisUi.data("line", line.trim(), { id: String(n) })),
        ),
      )
      const speech = Stream.fromQueue(text).pipe(
        synthesizeText(provider),
        Stream.map((chunk) => Frame.media(SPEAKER, chunk.bytes)),
        Stream.catch((error) => Stream.fromEffect(entry(SynthesisUi.live("problem", error._tag)))),
      )
      return Stream.make(speaker).pipe(Stream.concat(Stream.merge(lines, speech)))
    }),
  )
