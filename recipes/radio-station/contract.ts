/**
 * What the station tells a listener, shared by the server and the browser.
 *
 *   data "station"  (id "station")  the brief and the length of the set
 *   data "track"    (id = index)    one per track, updated in place:
 *                                   generating, then ready
 *   media           (id "track-N")  a finished track, as a URL this server serves
 *   live "listening"                the track a listener reached, so a reload resumes there
 *   live "problem"                  the station stopped: the error's tag
 */
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const StationInfo = Schema.Struct({ brief: Schema.String, total: Schema.Number })

export const TrackEntry = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  status: Schema.Literals(["generating", "ready"]),
})
export type TrackEntry = typeof TrackEntry.Type

export const StationUi = UiContract.make({
  data: { station: StationInfo, track: TrackEntry },
  live: { listening: Schema.Number, problem: Schema.String },
})

/** `POST /play` and `GET /status` answer with the station's stream id. */
export const StatusResponse = Schema.Struct({
  streamId: Schema.String,
  /** Whether someone has pressed Start since the server started. */
  playing: Schema.Boolean,
})

/** `POST /listening`: the track a listener just started. */
export const ListeningBody = Schema.Struct({ index: Schema.Number })
