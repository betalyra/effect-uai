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
 * forwards what arrives. `Projection.fromRealtime` turns the session into
 * what the page sees.
 */
import { Cause, Effect, Fiber, Match, Queue, Ref, Stream } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import type { ImageSource } from "@effect-uai/core/Image"
import type * as Items from "@effect-uai/core/Items"
import { RealtimeInput } from "@effect-uai/core/Realtime"
import type { RealtimeEvent } from "@effect-uai/core/Realtime"
import * as RealtimeSession from "@effect-uai/core/RealtimeSession"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Frame from "@effect-uai/ui/Frame"
import * as Projection from "@effect-uai/ui/Projection"
import type * as Run from "@effect-uai/ui/Run"
import { type Json, RunId, type RunEvent } from "@effect-uai/ui/RunEvent"
import { CAMERA, MIC, SPEAKER, type Up } from "./contract.js"

export type AssistantConfig = {
  readonly model: string
  readonly instructions: string
  readonly voiceId: string
  readonly inputFormat: AudioFormat
  readonly outputFormat: AudioFormat
}

/** Where the frames come from: the page's camera or screen, or a stream of the app's own. */
export type Frames =
  | { readonly _tag: "page"; readonly source: "camera" | "screen" }
  | { readonly _tag: "own"; readonly frames: Stream.Stream<ImageSource> }

/** A tool's output as the page shows it: the JSON it returned, or its text. */
const shown = (output: Items.ToolCallOutput): Json => {
  const parts = output.output.flatMap((part): ReadonlyArray<Json> =>
    Match.value(part).pipe(
      Match.discriminatorsExhaustive("type")({
        input_json: (p) => [p.value],
        input_text: (p) => [p.text],
        input_image: () => [],
        input_file: () => [],
      }),
    ),
  )
  return parts.length === 1 ? (parts[0] ?? null) : parts
}

const toolResult = (call: Items.ToolCall, output: Items.ToolCallOutput): RunEvent => ({
  type: "tool-result",
  callId: call.call_id,
  name: call.name,
  result:
    output.isError === true
      ? { _tag: "Failure", error: shown(output) }
      : { _tag: "Success", value: shown(output) },
})

const event = (e: RunEvent): Frame.Frame<Run.Owned> => Frame.message({ event: e })

const jpeg = (bytes: Uint8Array): ImageSource => ({ _tag: "bytes", bytes, mimeType: "image/jpeg" })

/**
 * Open a session and run it for as long as the returned stream is read:
 * `up` carries the microphone, the camera and typed messages in; the stream
 * carries the session out, as frames for `Frame.sequence`.
 */
export const runAssistant = <T extends Toolkit.Toolkit>(
  cfg: AssistantConfig,
  toolkit: T,
  frames: Frames,
  up: Stream.Stream<Frame.Frame<Up>>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const session = yield* RealtimeSession.open({
        model: cfg.model,
        instructions: cfg.instructions,
        voiceId: cfg.voiceId,
        inputFormat: cfg.inputFormat,
        outputFormat: cfg.outputFormat,
        tools: Toolkit.descriptors(toolkit),
      })

      // Tool fibers by `call_id`. An entry lives until its result is sent or the
      // call is cancelled, never to the end of the response: the turn that
      // carries a call routinely finishes while the tool is still working.
      const pending = yield* Ref.make<ReadonlyArray<readonly [string, Fiber.Fiber<void, never>]>>(
        [],
      )
      // What the page sees beside the session's own events: tool results, frame counts.
      const side = yield* Queue.unbounded<Frame.Frame<Run.Owned>, Cause.Done>()
      const seen = yield* Ref.make(0)
      // The session's own scope: tool fibers forked from the event stream live in it.
      const scope = yield* Effect.scope

      const show = (frame: ImageSource) =>
        Effect.andThen(
          RealtimeSession.sendVideoFrame(session, frame),
          Effect.flatMap(
            Ref.updateAndGet(seen, (n) => n + 1),
            (count) => Queue.offer(side, event({ type: "live", name: "frames", value: count })),
          ),
        )

      yield* up.pipe(
        Stream.runForEach(
          Frame.Frame.$match({
            Media: ({ channel, bytes }) =>
              Match.value(channel).pipe(
                Match.when(MIC, () => session.send(RealtimeInput.Audio({ bytes }))),
                Match.when(CAMERA, () =>
                  frames._tag === "page" ? Effect.asVoid(show(jpeg(bytes))) : Effect.void,
                ),
                Match.orElse(() => Effect.void),
              ),
            Message: ({ message }) => session.send(RealtimeInput.Text({ text: message.text })),
          }),
        ),
        Effect.forkScoped,
      )
      if (frames._tag === "own") {
        yield* frames.frames.pipe(Stream.runForEach(show), Effect.forkScoped)
      }

      const runTool = (responseId: string, call: Items.ToolCall) =>
        Toolkit.run(toolkit, [call]).pipe(
          Stream.filter(Toolkit.isOutcome),
          Stream.mapEffect(Toolkit.output(toolkit)),
          Stream.runForEach((output) =>
            Effect.gen(function* () {
              yield* session.send(RealtimeInput.ToolResult({ output }))
              yield* Ref.update(pending, (xs) => xs.filter(([id]) => id !== call.call_id))
              yield* Queue.offer(
                side,
                Frame.message({ runId: RunId.make(responseId), event: toolResult(call, output) }),
              )
            }),
          ),
          // A rejected result is invisible otherwise: the model simply never
          // answers, and the page shows a call that never lands.
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("[tool] failed", { name: call.name, cause: Cause.pretty(cause) }),
          ),
          Effect.ignore,
        )

      // What the projection leaves to the app: the tools. The provider owns
      // barge-in here, and there is no truncate to send after it.
      const act = (e: RealtimeEvent) =>
        Match.value(e).pipe(
          Match.tag("ToolCall", (call) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.forkIn(runTool(call.responseId, call.call), scope)
              yield* Ref.update(pending, (xs) => [...xs, [call.call.call_id, fiber] as const])
            }),
          ),
          Match.tag("ToolCallCancelled", (cancelled) =>
            Ref.modify(pending, (xs) => [
              xs.filter(([id]) => cancelled.callIds.includes(id)),
              xs.filter(([id]) => !cancelled.callIds.includes(id)),
            ]).pipe(
              Effect.flatMap((doomed) =>
                Effect.forEach(doomed, ([, fiber]) => Fiber.interrupt(fiber), { discard: true }),
              ),
            ),
          ),
          Match.orElse(() => Effect.void),
        )

      // The page records at the model's rate, and shows a camera switch only
      // when it is the one that supplies the frames.
      const opening: ReadonlyArray<Frame.Frame<Run.Owned>> = [
        event({
          type: "channel-opened",
          channel: MIC,
          direction: "up",
          mimeType: "audio/pcm",
          sampleRate: cfg.inputFormat.sampleRate,
          channels: 1,
        }),
        ...(frames._tag === "page"
          ? [
              event({
                type: "channel-opened",
                channel: CAMERA,
                direction: "up",
                mimeType: "image/jpeg",
              }),
              event({ type: "live", name: "source", value: frames.source }),
            ]
          : []),
      ]

      return Stream.fromIterable(opening).pipe(
        Stream.concat(
          session.events.pipe(
            Stream.tap(act),
            Projection.fromRealtime({
              channel: SPEAKER,
              format: { sampleRate: cfg.outputFormat.sampleRate },
            }),
            Stream.merge(Stream.fromQueue(side), { haltStrategy: "left" }),
          ),
        ),
      )
    }),
  )
