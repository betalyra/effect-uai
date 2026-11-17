/**
 * What the voice loop's live session carries, shared by the server and the client.
 *
 *   channel-opened  (MIC, up)          the mic format the transcriber expects
 *   data "transcript" (id = n)         one per utterance the user speaks
 *   run "assistant"                    one per reply:
 *     data "prompt"                      what the user said, as the turn heard it
 *     channel-opened (SPEAKER, down)     the reply's audio format
 *     text-delta                         the reply's text
 *     run-stopped { reason: "stop-word" } the user cut it short: drop queued audio
 *   live "problem"                     the pipeline failed or the provider reported an error
 *
 * Nothing goes up but mic audio.
 */
import * as Projection from "@effect-uai/ui/Projection"
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const VoiceUi = UiContract.make({
  data: { transcript: Projection.Utterance, prompt: Schema.String },
  live: { problem: Schema.String },
})

export const Up = Schema.Never

export const MIC = 0
export const SPEAKER = 1
