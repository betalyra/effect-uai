/**
 * A realtime voice agent, wired by hand.
 *
 * The session is the transport: it carries audio both ways and tells you what
 * the model is doing. Everything else is here in the open, because a realtime
 * conversation has no single right policy. Tools run in their own fibers so
 * the conversation stays live while they work, and those fibers are
 * interrupted when the model abandons the calls. When the model reports an
 * interruption, the browser stops the voice and says how much of the answer
 * was actually heard, so the part they missed leaves the context.
 *
 * There is no agent wrapper doing this for you. Adding a provider is a Layer
 * swap in `app.ts`; this file does not change.
 */
import { Cause, Effect, Fiber, Match, Ref, Stream } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import { RealtimeInput } from "@effect-uai/core/Realtime"
import * as RealtimeSession from "@effect-uai/core/RealtimeSession"
import { isOutput } from "@effect-uai/core/ToolEvent"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"
import * as Toolkit from "@effect-uai/core/Toolkit"

/** What the browser is told. Rendering is the client's business. */
export type StatusEvent =
  | { readonly type: "user-transcript"; readonly text: string; readonly final: boolean }
  | { readonly type: "assistant-started" }
  | { readonly type: "assistant-delta"; readonly text: string }
  | { readonly type: "assistant-done"; readonly reason: string }
  | { readonly type: "speech-started" }
  /** Stop the voice now and report how far it got. */
  | { readonly type: "interrupted" }
  | { readonly type: "tool-call"; readonly name: string; readonly arguments: string }
  | { readonly type: "tool-done"; readonly name: string }
  | { readonly type: "tool-cancelled"; readonly count: number }
  | { readonly type: "session-ending" }
  | { readonly type: "error"; readonly message: string }

export type AgentConfig = {
  readonly model: string
  readonly instructions: string
  readonly voiceId: string
  readonly inputFormat: AudioFormat
  readonly outputFormat: AudioFormat
}

export type AgentIO = {
  readonly mic: Stream.Stream<Uint8Array>
  readonly typed: Stream.Stream<string>
  /**
   * Milliseconds of the answer now playing that the listener actually heard,
   * reported when playback is cut. Only the browser knows this: the model
   * generates far faster than real time, so the server has usually handed over
   * a whole answer while the speakers are seconds behind.
   */
  readonly played: Stream.Stream<number>
  readonly sendStatus: (event: StatusEvent) => Effect.Effect<void>
  readonly sendAudio: (bytes: Uint8Array) => Effect.Effect<void>
}

/**
 * Open a session, forward the microphone, and answer events until the socket
 * closes. Runs for the lifetime of the surrounding scope.
 */
export const runAgent = <T extends Toolkit.Toolkit>(cfg: AgentConfig, toolkit: T, io: AgentIO) =>
  Effect.gen(function* () {
    const session = yield* RealtimeSession.open({
      model: cfg.model,
      instructions: cfg.instructions,
      voiceId: cfg.voiceId,
      inputFormat: cfg.inputFormat,
      outputFormat: cfg.outputFormat,
      tools: Toolkit.descriptors(toolkit),
    })

    // The answer the browser is playing, which a reported position belongs to.
    const speaking = yield* Ref.make("")
    // Tool fibers by `call_id`. An entry lives until its result is sent or the
    // call is cancelled, never to the end of the response: the response that
    // carries a call routinely finishes while the tool is still working.
    const pending = yield* Ref.make<ReadonlyArray<readonly [string, Fiber.Fiber<void, never>]>>([])

    yield* Effect.forkScoped(
      Stream.runForEach(io.mic, (bytes) => session.send(RealtimeInput.Audio({ bytes }))),
    )
    yield* Effect.forkScoped(
      Stream.runForEach(io.typed, (text) => session.send(RealtimeInput.Text({ text }))),
    )
    yield* Effect.forkScoped(
      Stream.runForEach(io.played, (playedMs) =>
        Effect.flatMap(Ref.get(speaking), (responseId) =>
          session.send(RealtimeInput.PlaybackPosition({ responseId, playedMs })),
        ),
      ),
    )

    yield* Stream.runForEach(session.events, (event) =>
      Match.value(event).pipe(
        Match.tag("ResponseStarted", (e) =>
          Effect.andThen(
            Ref.set(speaking, e.responseId),
            io.sendStatus({ type: "assistant-started" }),
          ),
        ),
        Match.tag("AudioDelta", (e) => io.sendAudio(e.bytes)),
        Match.tag("OutputTranscriptDelta", (e) =>
          io.sendStatus({ type: "assistant-delta", text: e.text }),
        ),
        // Display only. Transcripts are unordered against the response events,
        // so they cannot say when an answer stopped being wanted.
        Match.tag("InputTranscript", (e) =>
          io.sendStatus({ type: "user-transcript", text: e.text, final: e.final }),
        ),
        // Purely informational: the detector fires on any sound.
        Match.tag("SpeechStarted", () => io.sendStatus({ type: "speech-started" })),
        // The one thing that stops playback. It arrives in order, only while a
        // response is in flight, and the server has cancelled generation by
        // then. The browser answers it with the position on `played`.
        Match.tag("Interrupted", () => io.sendStatus({ type: "interrupted" })),
        Match.tag("ToolCall", (e) =>
          Effect.gen(function* () {
            yield* io.sendStatus({
              type: "tool-call",
              name: e.call.name,
              arguments: e.call.arguments,
            })
            // Forked, so the conversation stays live while the tool works.
            const fiber = yield* Effect.forkScoped(
              Toolkit.run(toolkit, [e.call]).pipe(
                Stream.runForEach((toolEvent) =>
                  isOutput(toolEvent)
                    ? Effect.gen(function* () {
                        yield* session.send(
                          RealtimeInput.ToolResult({
                            output: toToolCallOutput(toolEvent.result),
                          }),
                        )
                        yield* Ref.update(pending, (xs) =>
                          xs.filter(([id]) => id !== e.call.call_id),
                        )
                        yield* io.sendStatus({ type: "tool-done", name: e.call.name })
                      })
                    : Effect.void,
                ),
                // A rejected result is invisible otherwise: the model simply
                // never answers, and the page shows a call that never lands.
                Effect.tapCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError("[tool] failed", {
                        name: e.call.name,
                        cause: Cause.pretty(cause),
                      }),
                ),
                Effect.ignore,
              ),
            )
            yield* Ref.update(pending, (xs) => [...xs, [e.call.call_id, fiber] as const])
          }),
        ),
        Match.tag("ToolCallCancelled", (e) =>
          Effect.gen(function* () {
            // The model gave up on these, so stop the work rather than
            // answering a call nobody is waiting for.
            const doomed = yield* Ref.modify(pending, (xs) => [
              xs.filter(([id]) => e.callIds.includes(id)),
              xs.filter(([id]) => !e.callIds.includes(id)),
            ])
            yield* Effect.forEach(doomed, ([, fiber]) => Fiber.interrupt(fiber), {
              discard: true,
            })
            yield* io.sendStatus({ type: "tool-cancelled", count: doomed.length })
          }),
        ),
        Match.tag("ResponseDone", (e) =>
          io.sendStatus({ type: "assistant-done", reason: e.reason }),
        ),
        Match.tag("SessionEnding", () => io.sendStatus({ type: "session-ending" })),
        Match.tag("Error", (e) => io.sendStatus({ type: "error", message: e.message })),
        Match.orElse(() => Effect.void),
      ),
    )
  })
