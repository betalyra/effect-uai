/**
 * Types for a duplex speech-to-speech session: one long-lived connection the
 * server drives, rather than a caller-driven turn.
 *
 * Only what both OpenAI Realtime and Gemini Live do natively lives here. VAD
 * knobs, truncation, resumption, thinking, grounding and noise reduction are
 * provider-typed on each adapter's request.
 */
import { Data, type Duration } from "effect"
import type { AudioFormat } from "./Audio.js"
import type { ImageSource } from "./Image.js"
import type { HistoryItem, ToolCall, ToolCallOutput, Usage } from "./Items.js"
import type { ToolDescriptor } from "../tool/Tool.js"

/**
 * What the caller pushes into a live session.
 *
 * - `Audio`: encoded per `request.inputFormat`. The adapter neither paces nor
 *   buffers; send at real time.
 * - `Text`: role `system` maps to a system item where the provider has one and
 *   fails `Unsupported` where it does not.
 * - `Interrupt`: cancel the response in flight.
 * - `VideoFrame`: gated by the `RealtimeVideoInput` marker.
 * - `ActivityStart` / `ActivityEnd`: manual turn detection only; `ActivityEnd`
 *   also asks for a response. Dropped with a warning on a `"server"` session.
 * - `PlaybackPosition`: how much of a response the user actually heard, so the
 *   adapter can trim the rest from context. A no-op where the wire has no
 *   truncate.
 */
export type RealtimeInput = Data.TaggedEnum<{
  Audio: { readonly bytes: Uint8Array }
  Text: { readonly text: string; readonly role?: "user" | "system" }
  ToolResult: { readonly output: ToolCallOutput }
  Interrupt: {}
  VideoFrame: { readonly frame: ImageSource }
  ActivityStart: {}
  ActivityEnd: {}
  PlaybackPosition: { readonly responseId: string; readonly playedMs: number }
}>

export const RealtimeInput = Data.taggedEnum<RealtimeInput>()

/**
 * What the session emits. Every `AudioDelta` and `OutputTranscriptDelta` is
 * bracketed by `ResponseStarted` and `ResponseDone` carrying the same
 * `responseId`.
 *
 * - `InputTranscript`: transcription of the user's own speech.
 * - `SpeechStarted` / `SpeechStopped`: sparse. OpenAI emits them, Gemini
 *   does not.
 * - `Interrupted`: stop and flush playback now. Always precedes the
 *   `ResponseDone { reason: "interrupted" }` for that response.
 * - `ToolCallCancelled`: calls of an interrupted response that will never be
 *   answered.
 * - `ResumptionHandle`: Gemini only; pass it back as `request.resume`.
 * - `SessionEnding`: the connection is about to close on the server's terms.
 * - `Error`: non-fatal. A fatal error fails the stream instead.
 */
export type RealtimeEvent = Data.TaggedEnum<{
  ResponseStarted: { readonly responseId: string }
  AudioDelta: { readonly responseId: string; readonly bytes: Uint8Array }
  OutputTranscriptDelta: { readonly responseId: string; readonly text: string }
  InputTranscript: { readonly text: string; readonly final: boolean }
  SpeechStarted: {}
  SpeechStopped: {}
  ToolCall: { readonly responseId: string; readonly call: ToolCall }
  ToolCallCancelled: { readonly callIds: ReadonlyArray<string> }
  Interrupted: { readonly responseId: string }
  ResponseDone: {
    readonly responseId: string
    readonly reason: "complete" | "interrupted" | "cancelled" | "error"
    readonly usage?: Usage
  }
  ResumptionHandle: { readonly handle: string }
  SessionEnding: { readonly timeLeft?: Duration.Duration }
  Error: { readonly code?: string; readonly message: string }
}>

export const RealtimeEvent = Data.taggedEnum<RealtimeEvent>()

/**
 * Cross-provider session setup. Each adapter extends this, narrowing `model`
 * and adding its own knobs.
 */
export type CommonSessionRequest = {
  readonly model: string
  readonly instructions?: string
  readonly voiceId?: string
  /** `Toolkit.descriptors(toolkit)`. Immutable for the connection on Gemini. */
  readonly tools?: ReadonlyArray<ToolDescriptor>
  readonly inputFormat: AudioFormat
  readonly outputFormat: AudioFormat
  /** Who decides a turn ended. Defaults to `"server"`. */
  readonly turnDetection?: "server" | "manual"
  /** Transcribe the user's own audio. Defaults to `true`. */
  readonly transcribeInput?: boolean
  /** Text-only conversation seed. */
  readonly history?: ReadonlyArray<HistoryItem>
  /** A `ResumptionHandle` from a previous session. `Unsupported` off Gemini. */
  readonly resume?: string
}
