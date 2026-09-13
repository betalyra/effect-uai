/**
 * A duplex speech-to-speech session. The server drives turn-taking, so this is
 * its own primitive rather than a variant of `Loop`.
 *
 * The session is deliberately low level: tool execution, playback, barge-in
 * bookkeeping and reconnection are the caller's, built from `send` and
 * `events`. There is no agent wrapper, no hidden queue and no automatic
 * reconnect here.
 */
import { Context, Effect, type Scope, Stream } from "effect"
import type * as AiError from "../domain/AiError.js"
import type { ImageSource } from "../domain/Image.js"
import { type CommonSessionRequest, RealtimeInput, RealtimeEvent } from "../domain/Realtime.js"

/**
 * The live connection. `events` ends when the socket closes cleanly; a close
 * during a response ends it with `AiError.IncompleteTurn` instead, and never
 * synthesizes a `ResponseDone`. `send` after close fails `Unavailable`.
 */
export type RealtimeSessionHandle = {
  readonly send: (input: RealtimeInput) => Effect.Effect<void, AiError.AiError>
  readonly events: Stream.Stream<RealtimeEvent, AiError.AiError>
}

export type RealtimeSessionService = {
  /**
   * Connect and complete the provider handshake before succeeding. Closing the
   * `Scope` closes the socket.
   */
  readonly open: (
    request: CommonSessionRequest,
  ) => Effect.Effect<RealtimeSessionHandle, AiError.AiError, Scope.Scope>
}

export class RealtimeSession extends Context.Service<RealtimeSession, RealtimeSessionService>()(
  "@betalyra/effect-uai/RealtimeSession",
) {}

/**
 * Capability marker for sessions that accept video frames. Phantom: providers
 * register with `Layer.succeed(RealtimeVideoInput, undefined)`. Only Gemini
 * ships it, so `sendVideoFrame` against an OpenAI-only Layer is a type error.
 */
export class RealtimeVideoInput extends Context.Service<RealtimeVideoInput, void>()(
  "@betalyra/effect-uai/capability/RealtimeVideoInput",
) {}

/** Open a session for the lifetime of the surrounding `Scope`. */
export const open = (
  request: CommonSessionRequest,
): Effect.Effect<RealtimeSessionHandle, AiError.AiError, RealtimeSession | Scope.Scope> =>
  Effect.flatMap(RealtimeSession, (s) => s.open(request))

/**
 * Push one video frame. Requires `RealtimeVideoInput`, so a provider without
 * video fails at `Effect.provide` rather than at runtime.
 */
export const sendVideoFrame = (
  handle: RealtimeSessionHandle,
  frame: ImageSource,
): Effect.Effect<void, AiError.AiError, RealtimeVideoInput> =>
  Effect.flatMap(RealtimeVideoInput, () => handle.send(RealtimeInput.VideoFrame({ frame })))

const isAudioDelta = RealtimeEvent.$is("AudioDelta")
const isToolCall = RealtimeEvent.$is("ToolCall")

/** Just the audio, for wiring straight to playback. */
export const audioDeltas = <E, R>(
  events: Stream.Stream<RealtimeEvent, E, R>,
): Stream.Stream<Extract<RealtimeEvent, { readonly _tag: "AudioDelta" }>, E, R> =>
  Stream.filter(events, isAudioDelta)

/** Just the tool calls. Answer each with a `ToolResult`; the adapter resumes. */
export const toolCalls = <E, R>(
  events: Stream.Stream<RealtimeEvent, E, R>,
): Stream.Stream<Extract<RealtimeEvent, { readonly _tag: "ToolCall" }>, E, R> =>
  Stream.filter(events, isToolCall)
