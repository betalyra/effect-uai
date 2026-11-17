/**
 * The station manifest: everything a run needs to pick up where the last
 * one stopped.
 *
 * A clip's state is a tagged union rather than a string plus optional
 * fields, so "submitted" cannot exist without the job ref that makes it
 * resumable. That ref is the whole point: generation runs on fal, not
 * here, so a crash during polling costs nothing as long as the ref
 * reached disk first.
 */
import { Effect, FileSystem, Option, Schema } from "effect"
import * as Job from "@effect-uai/core/Job"

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

const ClipState = Schema.Union([
  Schema.TaggedStruct("planned", {}),
  Schema.TaggedStruct("submitted", { ref: Job.JobRef }),
  Schema.TaggedStruct("done", { file: Schema.String }),
])
export type ClipState = typeof ClipState.Type

const Clip = Schema.Struct({
  index: Schema.Number,
  /** The schedule slot: advert, news, ident, weather. Optional so a
   * manifest written before kinds existed still loads. */
  kind: Schema.optional(Schema.String),
  title: Schema.String,
  prompt: Schema.String,
  seconds: Schema.Number,
  state: ClipState,
})
export type Clip = typeof Clip.Type

export const Station = Schema.Struct({
  channel: Schema.String,
  /**
   * The standby card shown while the next clip renders. A still image
   * rather than a clip: it never has to loop, and a picture cannot be
   * put inside the stream without an encoder. Optional so an older
   * manifest still loads.
   */
  standby: Schema.optional(Schema.String),
  /** The card's image prompt, planned with the channel. Optional so an older manifest still loads. */
  card: Schema.optional(Schema.String),
  tagline: Schema.String,
  /** What the planner was told, so a changed brief is visible on disk. */
  brief: Schema.optional(Schema.String),
  budgetSeconds: Schema.Number,
  clipSeconds: Schema.Number,
  model: Schema.String,
  clips: Schema.Array(Clip),
})
export type Station = typeof Station.Type

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Seconds already committed to, whether rendered or still running. */
export const spentSeconds = (station: Station): number =>
  station.clips.reduce((total, clip) => total + clip.seconds, 0)

/** Whether another clip fits under the budget. `Infinity` never fills up. */
export const hasRoom = (station: Station): boolean =>
  spentSeconds(station) + station.clipSeconds <= station.budgetSeconds

export const withClip = (station: Station, clip: Clip): Station => ({
  ...station,
  clips: station.clips.map((c) => (c.index === clip.index ? clip : c)),
})

export const withClips = (station: Station, clips: ReadonlyArray<Clip>): Station => ({
  ...station,
  clips: [...station.clips, ...clips],
})

// ---------------------------------------------------------------------------
// Persistence
//
// Written through a `.partial` rename so a crash mid-write cannot leave a
// manifest that parses into a lie.
// ---------------------------------------------------------------------------

const asJson = Schema.fromJsonString(Station, { space: 2 })
const decode = Schema.decodeUnknownEffect(asJson)
const encode = Schema.encodeEffect(asJson)

/** `None` for both "no manifest" and "a manifest this version cannot read". */
export const read = (
  file: string,
): Effect.Effect<Option.Option<Station>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.orDie(fs.exists(file)).pipe(
      Effect.flatMap((exists) =>
        exists
          ? Effect.option(Effect.flatMap(fs.readFileString(file), decode))
          : Effect.succeedNone,
      ),
    )
  })

export const write = (
  file: string,
  station: Station,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const partial = `${file}.partial`
    yield* fs.writeFileString(partial, yield* Effect.orDie(encode(station)))
    yield* fs.rename(partial, file)
  }).pipe(Effect.orDie)
