/**
 * What crosses the live session, shared by the server and the client.
 *
 *   up              { text }              a line the user typed
 *   channel-opened  (channel 0, down)     the speech format: PCM s16le, 48 kHz mono
 *   data "line"     (id = n)              each line as the server took it
 *   live "problem"                        the synthesizer failed
 *   media frames    (channel 0)           the speech
 */
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const Say = Schema.Struct({ text: Schema.String })
export type Say = typeof Say.Type

export const SynthesisUi = UiContract.make({
  data: { line: Schema.String },
  live: { problem: Schema.String },
})

/** The channel the speech comes down on. */
export const SPEAKER = 0
