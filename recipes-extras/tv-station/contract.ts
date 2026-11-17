/**
 * What the station tells a viewer, shared by the server and the browser.
 *
 * The station is one session stream of stream-scoped entries, no runs:
 *
 *   data "station"  (id "station")  the channel, once planned
 *   data "clip"     (id = index)    one per slot, updated in place:
 *                                   planned, then the render job's states
 *   media           (id "clip-N")   a finished clip, as a URL this server serves
 *   live "screen"                   what is on screen now: a clip, or standby
 *
 * The picture itself is not here: it is one fragmented MP4 on `/stream`.
 */
import * as Job from "@effect-uai/core/Job"
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const StationInfo = Schema.Struct({
  channel: Schema.String,
  tagline: Schema.String,
  /** `null` under `--infinite`, where the running order has no end. */
  total: Schema.NullOr(Schema.Number),
})

/** A render job's state on the wire: the clip itself arrives as `media`, a failure as its message. */
export const RenderState = Job.JobStateSchema(Schema.Struct({}), Schema.String)

export const ClipEntry = Schema.Struct({
  index: Schema.Number,
  kind: Schema.String,
  title: Schema.String,
  /** Absent while the slot is only planned. */
  render: Schema.optionalKey(RenderState),
})
export type ClipEntry = typeof ClipEntry.Type

export const OnAir = Schema.TaggedStruct("clip", {
  index: Schema.Number,
  cycle: Schema.Number,
  title: Schema.String,
})
/** The card is up: clip `next` is still rendering. */
export const Standby = Schema.TaggedStruct("standby", { next: Schema.Number })

export const Screen = Schema.Union([OnAir, Standby])
export type Screen = typeof Screen.Type

export const StationUi = UiContract.make({
  data: { station: StationInfo, clip: ClipEntry },
  live: {
    screen: Screen,
    /** The station stopped: the error's tag. The details are in the server log. */
    problem: Schema.String,
  },
})

// ---------------------------------------------------------------------------
// The control routes
// ---------------------------------------------------------------------------

/** `POST /play` and `GET /status` answer with the station's stream id. */
export const StatusResponse = Schema.Struct({
  streamId: Schema.String,
  /** Whether someone has pressed Play since the server started. */
  playing: Schema.Boolean,
})
