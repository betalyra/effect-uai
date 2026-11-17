/**
 * AI radio station. An LLM plans a set one track at a time from a brief
 * (structured output), and each track is generated with a streaming music
 * model, written to an on-disk MP3 cache.
 *
 * Generation keeps one track ahead of the listener: track N is made once
 * someone is listening to track N-1. A tab that closes stops nothing, but a
 * station nobody listens to stops paying after the next track.
 *
 * Shape: `runStation` is a stream of what a listener should know (entries
 * of `StationUi`, see contract.ts). The tracks themselves are files the
 * server serves; the browser plays them in order.
 */
import { Effect, Exit, FileSystem, Schema, Stream, SubscriptionRef } from "effect"
import * as Items from "@effect-uai/core/Items"
import { type LanguageModel, turn } from "@effect-uai/core/LanguageModel"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"
import type { RunEvent } from "@effect-uai/ui/RunEvent"
import { StationUi, type TrackEntry } from "./contract.js"

// ---------------------------------------------------------------------------
// Planner: one LLM call per track, just in time. Previous tracks are passed
// in as context so the model can keep the set coherent ("what would a DJ
// play after this").
// ---------------------------------------------------------------------------

const TrackPlan = Schema.Struct({
  title: Schema.String,
  prompt: Schema.String,
})
export type TrackPlan = typeof TrackPlan.Type

const trackFormat = StructuredFormat.fromEffectSchema(TrackPlan)

export const planTrack = (
  brief: string,
  index: number,
  total: number,
  previous: ReadonlyArray<TrackPlan>,
  model: string,
) => {
  const history =
    previous.length === 0
      ? `(this is the first track of the set)`
      : `Previous tracks so far:\n${previous
          .map((p, i) => `${i + 1}. ${p.title}: ${p.prompt}`)
          .join("\n")}`

  return turn({
    model,
    structured: trackFormat,
    history: [
      Items.userText(
        [
          `Plan track ${index + 1} of ${total} for this radio station: "${brief}".`,
          "",
          history,
          "",
          "Write:",
          "- title: a short evocative track name",
          "- prompt: a music-generation prompt describing vibe, instruments, tempo, mood",
          "",
          "Make this track distinct from the previous ones, but with a coherent arc, like a real DJ set transitioning.",
        ].join("\n"),
      ),
    ],
  }).pipe(Effect.flatMap((t) => Turn.decodeStructured(t, trackFormat)))
}

// ---------------------------------------------------------------------------
// One track on disk.
//
// A cached file is kept as it is; otherwise the generation is written to a
// `.partial` file as chunks arrive, renamed on success and removed on
// failure or interrupt, so a half-written track is never taken for a cached
// one.
// ---------------------------------------------------------------------------

export const trackFile = (index: number): string => `track-${index}.mp3`

const generateTrack = (plan: TrackPlan, index: number, tracksDir: string, musicModel: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = `${tracksDir}/${trackFile(index)}`
      if (yield* fs.exists(file).pipe(Effect.orDie)) return

      const partial = `${file}.partial`
      const handle = yield* fs.open(partial, { flag: "w" }).pipe(Effect.orDie)
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? fs.rename(partial, file).pipe(Effect.orDie)
          : fs.remove(partial, { force: true }).pipe(Effect.ignore),
      )
      yield* MusicGenerator.streamGeneration({
        model: musicModel,
        prompt: plan.prompt,
        outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
      }).pipe(Stream.runForEach((chunk) => handle.writeAll(chunk.bytes).pipe(Effect.orDie)))
    }),
  )

// ---------------------------------------------------------------------------
// The station
// ---------------------------------------------------------------------------

export type RunStationConfig = {
  readonly brief: string
  readonly trackCount: number
  readonly tracksDir: string
  readonly plannerModel: string
  readonly musicModel: string
  /**
   * The track a listener reached, `-1` before anyone has. Generation waits
   * until it is no more than one track behind.
   */
  readonly listening: SubscriptionRef.SubscriptionRef<number>
}

/** Our own values against our own schemas: a failure to encode is a bug, so it dies. */
const emit = (event: Effect.Effect<RunEvent, Schema.SchemaError>) =>
  Stream.fromEffect(Effect.orDie(event))

const entry = (index: number, plan: TrackPlan, status: TrackEntry["status"]) =>
  emit(StationUi.data("track", { index, title: plan.title, status }, { id: String(index) }))

/** A finished track, as a URL this server serves. */
const trackMedia = (index: number, plan: TrackPlan): RunEvent => ({
  type: "media",
  id: `track-${index}`,
  name: plan.title,
  source: { _tag: "url", url: `/tracks/${trackFile(index)}`, mimeType: "audio/mpeg" },
})

const reached = (listening: SubscriptionRef.SubscriptionRef<number>, index: number) =>
  SubscriptionRef.changes(listening).pipe(
    Stream.filter((at) => at >= index),
    Stream.runHead,
    Effect.asVoid,
  )

type StationError =
  | Effect.Error<ReturnType<typeof planTrack>>
  | Effect.Error<ReturnType<typeof generateTrack>>

type StationServices = FileSystem.FileSystem | MusicGenerator.MusicGenerator | LanguageModel

/** Track `index` onwards, each made once the listener is one track behind it. */
const tracks = (
  cfg: RunStationConfig,
  index: number,
  plans: ReadonlyArray<TrackPlan>,
): Stream.Stream<RunEvent, StationError, StationServices> =>
  index >= cfg.trackCount
    ? Stream.empty
    : Stream.unwrap(
        Effect.gen(function* () {
          yield* reached(cfg.listening, index - 1)
          const plan = yield* planTrack(cfg.brief, index, cfg.trackCount, plans, cfg.plannerModel)
          return entry(index, plan, "generating").pipe(
            Stream.concat(
              Stream.fromEffect(generateTrack(plan, index, cfg.tracksDir, cfg.musicModel)).pipe(
                Stream.drain,
              ),
            ),
            Stream.concat(entry(index, plan, "ready")),
            Stream.concat(Stream.succeed(trackMedia(index, plan))),
            Stream.concat(tracks(cfg, index + 1, [...plans, plan])),
          )
        }),
      )

export const runStation = (cfg: RunStationConfig) =>
  emit(
    StationUi.data("station", { brief: cfg.brief, total: cfg.trackCount }, { id: "station" }),
  ).pipe(Stream.concat(tracks(cfg, 0, [])))
