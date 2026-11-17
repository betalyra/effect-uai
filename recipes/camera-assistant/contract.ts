/**
 * What crosses the camera assistant's live session, shared by the server and the client.
 *
 *   up        { kind: "say", text }          a typed message
 *             media on MIC                   the microphone
 *             media on CAMERA                JPEG stills, while the camera is on
 *   down      channel-opened (MIC, up)       the rate the model listens at
 *             channel-opened (CAMERA, up)    only when frames come from the page
 *             live "source"                  which device to capture: camera or screen
 *             run "assistant" per answer     (Projection.fromRealtime) with its
 *                                            audio on SPEAKER
 *             data "transcript"              what the model heard the user say
 *             live "frames"                  how many frames the model has been shown
 *             live "vad" / "error" / "session-ending" / "problem"
 */
import * as Projection from "@effect-uai/ui/Projection"
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const Say = Schema.Struct({ kind: Schema.Literal("say"), text: Schema.String })
export const Up = Say
export type Up = typeof Up.Type

/** The tools as the page sees them: names only, values as JSON. */
const shown = { inputSchema: Schema.Json, outputSchema: Schema.Json, failureSchema: Schema.Json }

export const CameraUi = UiContract.make({
  tools: [{ name: "web_search", ...shown }] as const,
  data: { transcript: Projection.Utterance },
  live: {
    source: Schema.Literals(["camera", "screen"]),
    frames: Schema.Number,
    vad: Schema.Boolean,
    error: Schema.Struct({ code: Schema.optionalKey(Schema.String), message: Schema.String }),
    "session-ending": Schema.NullOr(Schema.Number),
    problem: Schema.String,
  },
})

export const MIC = 0
export const SPEAKER = 1
export const CAMERA = 2
