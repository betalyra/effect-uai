/**
 * Streaming transcription helper: takes a `Stream<Uint8Array>` of mic
 * frames (raw PCM s16le, provider-specific sample rate, mono) and
 * returns a `Stream<TranscriptEvent>` via the generic
 * `Transcriber.streamTranscriptionFrom` capability.
 *
 * The recipe stays provider-agnostic: `app.ts` picks the Layer, this file
 * the matching request shape. Adding a provider is one `Match.when` here and
 * one name in `app.ts`.
 */
import { Effect, Match, Stream } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as Transcriber from "@effect-uai/core/Transcriber"
import * as Transcript from "@effect-uai/core/Transcript"
import type * as Frame from "@effect-uai/ui/Frame"
import * as Projection from "@effect-uai/ui/Projection"
import type { RunEvent } from "@effect-uai/ui/RunEvent"
import { MIC, TranscriptUi } from "./contract.js"

export type Provider = "elevenlabs" | "openai" | "inworld"

/**
 * Two things travel with the model. `vadEvents` asks the server to detect turn
 * boundaries, which is what commits a turn into a final transcript; a model
 * that transcribes continuously rejects it. `joinPartials` stitches token-sized
 * deltas into a running sentence, for providers that stream fragments.
 */
export const providerConfig: (provider: Provider) => {
  readonly model: string
  readonly inputFormat: AudioFormat
  readonly vadEvents: boolean
  readonly joinPartials: boolean
} = Match.type<Provider>().pipe(
  Match.when("elevenlabs", () => ({
    model: "scribe_v2_realtime",
    vadEvents: true,
    joinPartials: false,
    inputFormat: {
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    } satisfies AudioFormat,
  })),
  Match.when("openai", () => ({
    model: "gpt-transcribe",
    vadEvents: true,
    joinPartials: true,
    inputFormat: {
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 24000,
      channels: 1,
    } satisfies AudioFormat,
  })),
  Match.when("inworld", () => ({
    model: "inworld/inworld-stt-1",
    vadEvents: true,
    joinPartials: false,
    inputFormat: {
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    } satisfies AudioFormat,
  })),
  Match.exhaustive,
)

export const transcribeMicStream =
  (provider: Provider) =>
  <E, R>(audioIn: Stream.Stream<Uint8Array, E, R>) => {
    const { joinPartials, ...request } = providerConfig(provider)
    const events = audioIn.pipe(
      Transcriber.streamTranscriptionFrom({ ...request, wordTimestamps: true }),
    )
    return joinPartials ? events.pipe(Transcript.accumulatePartials()) : events
  }

/** Tells the browser what to send on the mic channel: the rate the provider takes. */
const micChannel = (provider: Provider): RunEvent => ({
  type: "channel-opened",
  channel: MIC,
  direction: "up",
  mimeType: "audio/pcm",
  sampleRate: providerConfig(provider).inputFormat.sampleRate,
  channels: 1,
})

const utterances = Projection.transcriptStep("transcript")

/**
 * One `transcript` entry per utterance (`Projection.transcriptStep`: partials
 * overwrite it, its final settles it); a provider error becomes a `problem`.
 */
const toEntries = <E, R>(events: Stream.Stream<Transcript.TranscriptEvent, E, R>) =>
  events.pipe(
    Stream.mapAccum(
      () => 0,
      (n, event): readonly [number, ReadonlyArray<RunEvent>] =>
        event._tag === "error"
          ? [n, [{ type: "live", name: "problem", value: event.message }]]
          : utterances(n, event),
    ),
  )

/**
 * The live session: declare the mic format, then transcribe the mic frames
 * into utterance entries. A transcriber failure ends the session with a
 * `problem` the page can show.
 */
export const transcriptSession =
  (provider: Provider) => (up: Stream.Stream<Frame.Frame<never>>) => {
    const mic = up.pipe(
      Stream.filter(
        (frame): frame is Frame.Media => frame._tag === "Media" && frame.channel === MIC,
      ),
      Stream.map((frame) => frame.bytes),
    )
    return Stream.make(micChannel(provider)).pipe(
      Stream.concat(mic.pipe(transcribeMicStream(provider), toEntries)),
      Stream.catch((error) =>
        Stream.fromEffect(Effect.orDie(TranscriptUi.live("problem", error._tag))),
      ),
    )
  }
