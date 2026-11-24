/**
 * A realtime voice agent, wired by hand.
 *
 * The session is the transport: it carries audio both ways and tells you what
 * the model is doing. `Projection.fromRealtime` turns that into what the
 * browser sees: each answer a run with its own audio channel, a barge-in a
 * `run-stopped`. Everything else is here in the open, because a realtime
 * conversation has no single right policy. Tools run in their own fibers so
 * the conversation stays live while they work, and those fibers are
 * interrupted when the model abandons the calls. When an answer is cut off,
 * the browser says how much of it was actually heard, so the part they missed
 * leaves the context.
 *
 * There is no agent wrapper doing this for you. Adding a provider is a Layer
 * swap in `app.ts`; this file does not change.
 */
import { Cause, Effect, FiberMap, Match, Queue, Ref, Stream } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import type * as Items from "@effect-uai/core/Items"
import { RealtimeInput } from "@effect-uai/core/Realtime"
import type { RealtimeEvent } from "@effect-uai/core/Realtime"
import * as RealtimeSession from "@effect-uai/core/RealtimeSession"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Frame from "@effect-uai/ui/Frame"
import * as Projection from "@effect-uai/ui/Projection"
import type * as Run from "@effect-uai/ui/Run"
import { type Json, RunId, type RunEvent } from "@effect-uai/ui/RunEvent"
import { MIC, SPEAKER, type Up } from "./contract.js"

export type AgentConfig = {
  readonly model: string
  readonly instructions: string
  readonly voiceId: string
  readonly inputFormat: AudioFormat
  readonly outputFormat: AudioFormat
}

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

/**
 * Open a session and run it for as long as the returned stream is read:
 * `up` carries the microphone, typed messages and playback positions in;
 * the stream carries the session out, as frames for `Frame.sequence`.
 */
export const runAgent = <T extends Toolkit.Toolkit>(
  cfg: AgentConfig,
  toolkit: T,
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

      // The answer the browser is playing, which a reported position belongs to.
      const speaking = yield* Ref.make("")
      // Tool fibers by `call_id`, in the session's scope. An entry lives until
      // its tool is done or the call is cancelled, never to the end of the
      // response: the response that carries a call routinely finishes while the
      // tool is still working.
      const pending = yield* FiberMap.make<string>()
      // Tool results, which arrive from tool fibers rather than from the session.
      const results = yield* Queue.unbounded<Frame.Frame<Run.Owned>, Cause.Done>()

      yield* up.pipe(
        Stream.runForEach(
          Frame.Frame.$match({
            Media: ({ channel, bytes }) =>
              channel === MIC ? session.send(RealtimeInput.Audio({ bytes })) : Effect.void,
            Message: ({ message }) =>
              Match.value(message).pipe(
                Match.discriminatorsExhaustive("kind")({
                  say: ({ text }) => session.send(RealtimeInput.Text({ text })),
                  playback: ({ playedMs }) =>
                    Effect.flatMap(Ref.get(speaking), (responseId) =>
                      session.send(RealtimeInput.PlaybackPosition({ responseId, playedMs })),
                    ),
                }),
              ),
          }),
        ),
        Effect.forkScoped,
      )

      const runTool = (responseId: string, call: Items.ToolCall) =>
        Toolkit.run(toolkit, [call]).pipe(
          Stream.filter(Toolkit.isOutcome),
          Stream.mapEffect(Toolkit.output(toolkit)),
          // Once the model has the result, the page gets it too, even if a cancel lands now.
          Stream.runForEach((output) =>
            Effect.uninterruptible(
              Effect.andThen(
                session.send(RealtimeInput.ToolResult({ output })),
                Queue.offer(
                  results,
                  Frame.message({ runId: RunId.make(responseId), event: toolResult(call, output) }),
                ),
              ),
            ),
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

      // What the projection leaves to the app: who is speaking, and the tools.
      const act = (event: RealtimeEvent) =>
        Match.value(event).pipe(
          Match.tag("ResponseStarted", (e) => Ref.set(speaking, e.responseId)),
          // Forked, so the conversation stays live while the tool works.
          Match.tag("ToolCall", (e) =>
            Effect.asVoid(FiberMap.run(pending, e.call.call_id, runTool(e.responseId, e.call))),
          ),
          // The model gave up on these, so stop the work rather than answering
          // a call nobody is waiting for. The projection closes them on the page.
          Match.tag("ToolCallCancelled", (e) =>
            Effect.forEach(e.callIds, (id) => FiberMap.remove(pending, id), { discard: true }),
          ),
          Match.orElse(() => Effect.void),
        )

      const mic: Frame.Frame<Run.Owned> = Frame.message({
        event: {
          type: "channel-opened",
          channel: MIC,
          direction: "up",
          mimeType: "audio/pcm",
          sampleRate: cfg.inputFormat.sampleRate,
          channels: 1,
        },
      })

      return Stream.make(mic).pipe(
        Stream.concat(
          session.events.pipe(
            Stream.tap(act),
            Projection.fromRealtime({
              channel: SPEAKER,
              format: { sampleRate: cfg.outputFormat.sampleRate },
            }),
            Stream.merge(Stream.fromQueue(results), { haltStrategy: "left" }),
          ),
        ),
      )
    }),
  )
