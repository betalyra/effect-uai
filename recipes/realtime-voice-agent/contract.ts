/**
 * What crosses the realtime agent's live session, shared by the server and the client.
 *
 *   up        { kind: "say", text }          a typed message
 *             Input.Playback                 how much of a cut-off answer was heard
 *             media on MIC                   the microphone
 *   down      channel-opened (MIC, up)       the rate the model listens at
 *             run "assistant" per answer     (Projection.fromRealtime): its text,
 *                                            its tool calls and their results, its
 *                                            audio on SPEAKER; a barge-in ends it
 *                                            `run-stopped { reason: "barge-in" }`
 *             data "transcript"              what the model heard the user say
 *             live "vad" / "error" / "session-ending" / "problem"
 */
import * as Input from "@effect-uai/ui/Input"
import * as Projection from "@effect-uai/ui/Projection"
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const Say = Schema.Struct({ kind: Schema.Literal("say"), text: Schema.String })

export const Up = Schema.Union([Say, Input.Playback])
export type Up = typeof Up.Type

/**
 * The tools as the page sees them: names only, values as JSON, so the
 * browser bundle carries none of the tools' code. `app.ts` has the real ones.
 */
const shown = { inputSchema: Schema.Json, outputSchema: Schema.Json, failureSchema: Schema.Json }

export const AgentUi = UiContract.make({
  tools: [
    { name: "get_current_time", ...shown },
    { name: "get_weather", ...shown },
    { name: "web_search", ...shown },
  ] as const,
  data: { transcript: Projection.Utterance },
  live: {
    vad: Schema.Boolean,
    error: Schema.Struct({ code: Schema.optionalKey(Schema.String), message: Schema.String }),
    "session-ending": Schema.NullOr(Schema.Number),
    problem: Schema.String,
  },
})

export const MIC = 0
export const SPEAKER = 1
