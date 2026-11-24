/**
 * What the live session tells the browser, shared by the server and the client.
 *
 *   channel-opened    (channel 0, up)  the mic format the provider expects
 *   data "transcript" (id = n)         one per utterance: partials overwrite it until its final
 *   live "problem"                     the transcriber failed or reported an error
 *
 * Nothing goes up but mic audio, so there are no upstream messages.
 */
import * as Projection from "@effect-uai/ui/Projection"
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const TranscriptUi = UiContract.make({
  data: { transcript: Projection.Utterance },
  live: { problem: Schema.String },
})

export const Up = Schema.Never

/** The channel the browser sends its mic on. */
export const MIC = 0
