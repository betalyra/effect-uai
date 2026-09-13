/**
 * A camera assistant: the same duplex session as a voice agent, with frames
 * as one more input on it. You point a camera at something, ask about it out
 * loud, and the answer comes back as speech.
 *
 * `sendVideoFrame` needs the `RealtimeVideoInput` marker, so this file only
 * compiles against a provider that has video. Handing it an audio-only Layer
 * is a type error at composition, not a failure mid-conversation.
 *
 * Frames are expensive, so who decides when to send one matters. Here the
 * browser sends them only while it hears the user, and this file just
 * forwards what arrives.
 */
import { Cause, Effect, Fiber, Match, Ref, Stream } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import type { ImageSource } from "@effect-uai/core/Image"
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
  /** Stop the voice: the model has abandoned what it was saying. */
  | { readonly type: "interrupted" }
  /** How many frames the model has been shown so far. */
  | { readonly type: "frames"; readonly count: number }
  | { readonly type: "tool-call"; readonly name: string; readonly arguments: string }
  | { readonly type: "tool-done"; readonly name: string }
  | { readonly type: "tool-cancelled"; readonly count: number }
  | { readonly type: "session-ending" }
  | { readonly type: "error"; readonly message: string }

export type AssistantConfig = {
  readonly model: string
  readonly instructions: string
  readonly voiceId: string
  readonly inputFormat: AudioFormat
  readonly outputFormat: AudioFormat
}

export type AssistantIO = {
  readonly mic: Stream.Stream<Uint8Array>
  /** JPEG stills, paced by whoever produces them. At most one per second. */
  readonly frames: Stream.Stream<ImageSource>
  readonly typed: Stream.Stream<string>
  readonly sendStatus: (event: StatusEvent) => Effect.Effect<void>
  readonly sendAudio: (bytes: Uint8Array) => Effect.Effect<void>
}

/**
 * Open a session, forward microphone and camera, and answer events until the
 * socket closes. Runs for the lifetime of the surrounding scope.
 */
export const runAssistant = <T extends Toolkit.Toolkit>(
  cfg: AssistantConfig,
  toolkit: T,
  io: AssistantIO,
) =>
  Effect.gen(function* () {
    const session = yield* RealtimeSession.open({
      model: cfg.model,
      instructions: cfg.instructions,
      voiceId: cfg.voiceId,
      inputFormat: cfg.inputFormat,
      outputFormat: cfg.outputFormat,
      tools: Toolkit.descriptors(toolkit),
    })

    const seen = yield* Ref.make(0)
    const pending = yield* Ref.make<ReadonlyArray<readonly [string, Fiber.Fiber<void, never>]>>([])

    yield* Effect.forkScoped(
      Stream.runForEach(io.mic, (bytes) => session.send(RealtimeInput.Audio({ bytes }))),
    )
    yield* Effect.forkScoped(
      Stream.runForEach(io.typed, (text) => session.send(RealtimeInput.Text({ text }))),
    )
    yield* Effect.forkScoped(
      Stream.runForEach(io.frames, (frame) =>
        Effect.andThen(
          RealtimeSession.sendVideoFrame(session, frame),
          Effect.flatMap(
            Ref.updateAndGet(seen, (n) => n + 1),
            (count) => io.sendStatus({ type: "frames", count }),
          ),
        ),
      ),
    )

    yield* Stream.runForEach(session.events, (event) =>
      Match.value(event).pipe(
        Match.tag("ResponseStarted", () => io.sendStatus({ type: "assistant-started" })),
        Match.tag("AudioDelta", (e) => io.sendAudio(e.bytes)),
        Match.tag("OutputTranscriptDelta", (e) =>
          io.sendStatus({ type: "assistant-delta", text: e.text }),
        ),
        Match.tag("InputTranscript", (e) =>
          io.sendStatus({ type: "user-transcript", text: e.text, final: e.final }),
        ),
        // The provider owns barge-in here, and there is no truncate to send
        // after it: what the listener missed stays in the model's context.
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
                    ? Effect.andThen(
                        session.send(
                          RealtimeInput.ToolResult({
                            output: toToolCallOutput(toolEvent.result),
                          }),
                        ),
                        io.sendStatus({ type: "tool-done", name: e.call.name }),
                      )
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
            const running = yield* Ref.getAndUpdate(pending, (xs) =>
              xs.filter(([id]) => !e.callIds.includes(id)),
            )
            const doomed = running.filter(([id]) => e.callIds.includes(id))
            yield* Effect.forEach(doomed, ([, fiber]) => Fiber.interrupt(fiber), { discard: true })
            yield* io.sendStatus({ type: "tool-cancelled", count: doomed.length })
          }),
        ),
        Match.tag("ResponseDone", (e) =>
          Effect.andThen(
            Ref.set(pending, []),
            io.sendStatus({ type: "assistant-done", reason: e.reason }),
          ),
        ),
        Match.tag("SessionEnding", () => io.sendStatus({ type: "session-ending" })),
        Match.tag("Error", (e) => io.sendStatus({ type: "error", message: e.message })),
        Match.orElse(() => Effect.void),
      ),
    )
  })
