/**
 * AI radio station. An LLM plans an N-track station from a brief
 * (Responses + structured output); each track is generated with
 * ElevenLabs Music streaming and tee'd chunk-by-chunk into both the
 * outgoing stream and an on-disk MP3 cache. The station loops forever:
 * cycle 2+ replays from the cache for free.
 *
 * Pipelining: one background prefetch fiber always runs one track
 * ahead of playback. By the time the current track ends, the next is
 * already on disk and streams from cache instantly.
 *
 * Shape: `runStation` returns a single `Stream<string | Uint8Array>`
 * that interleaves JSON event frames (control) and binary chunks
 * (audio). The transport (WebSocket, SSE, whatever) just pipes it; no
 * `send` / `sendBytes` callbacks. The only external input is
 * `waitTrackEnded`, an Effect that resolves when the consumer signals
 * the track finished playing (backpressure on actual listening time).
 */
import { Effect, Exit, Fiber, FileSystem, Option, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import { turn } from "@effect-uai/core/LanguageModel"
import { loop, next, value } from "@effect-uai/core/Loop"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Planner — one LLM call per track, just-in-time. Previous tracks are
// passed in as context so the model can keep the set coherent (think
// "what would a DJ play after this").
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
          .map((p, i) => `${i + 1}. ${p.title} — ${p.prompt}`)
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
          "Make this track distinct from the previous ones, but with a coherent arc — like a real DJ set transitioning.",
        ].join("\n"),
      ),
    ],
  }).pipe(Effect.flatMap((t) => Turn.decodeStructured(t, trackFormat)))
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export type ServerEvent =
  | {
      readonly type: "station-info"
      readonly brief: string
      readonly total: number
    }
  | { readonly type: "track-planned"; readonly index: number; readonly title: string }
  | {
      readonly type: "track-start"
      readonly index: number
      readonly cycle: number
      readonly title: string
    }
  | { readonly type: "track-end"; readonly index: number }
  | { readonly type: "data"; readonly bytes: Uint8Array }

export type ClientEvent = { readonly type: "track-ended" }

export type RunStationConfig = {
  readonly brief: string
  readonly trackCount: number
  readonly tracksDir: string
  readonly plannerModel: string
  readonly musicModel: string
  /** Resolves once when the consumer signals `{type:"track-ended"}`. */
  readonly waitTrackEnded: Effect.Effect<void>
}

// ---------------------------------------------------------------------------
// Producer: returns a Stream<Uint8Array> of MP3 bytes. Does not drain.
//
// Cache lives inside the stream: file exists → read it; otherwise →
// generate, tee'd into a scoped file handle as chunks flow. On success
// the .partial file is renamed to the final path; on failure/interrupt
// it's removed so the next attempt doesn't read a half-written file as
// a cache hit.
// ---------------------------------------------------------------------------

const trackStream = (plan: TrackPlan, index: number, tracksDir: string, musicModel: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = `${tracksDir}/track-${index}.mp3`

      if (yield* fs.exists(file).pipe(Effect.orDie)) {
        return fs.stream(file).pipe(Stream.orDie)
      }

      const partial = `${file}.partial`
      const handle = yield* fs.open(partial, { flag: "w" }).pipe(Effect.orDie)
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? fs.rename(partial, file).pipe(Effect.orDie)
          : fs.remove(partial, { force: true }).pipe(Effect.ignore),
      )

      return MusicGenerator.streamGeneration({
        model: musicModel,
        prompt: plan.prompt,
        outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
      }).pipe(
        Stream.map((c) => c.bytes),
        Stream.tap((bytes) => handle.writeAll(bytes).pipe(Effect.orDie)),
      )
    }),
  )

// ---------------------------------------------------------------------------
// Prefetch fiber body: either reuse an existing plan (cycle 1+) or plan
// a fresh one (cycle 0). Returns the new plan if it generated one, so
// the next loop iteration can append it to `plans` and emit
// `track-planned`.
// ---------------------------------------------------------------------------

type PrefetchResult = { readonly newPlan: Option.Option<TrackPlan> }

const prefetch = (cfg: RunStationConfig, index: number, plans: ReadonlyArray<TrackPlan>) =>
  index < plans.length
    ? trackStream(plans[index]!, index, cfg.tracksDir, cfg.musicModel).pipe(
        Stream.runDrain,
        Effect.orDie,
        Effect.as<PrefetchResult>({ newPlan: Option.none() }),
      )
    : planTrack(cfg.brief, index, cfg.trackCount, plans, cfg.plannerModel).pipe(
        Effect.flatMap((p) =>
          trackStream(p, index, cfg.tracksDir, cfg.musicModel).pipe(
            Stream.runDrain,
            Effect.orDie,
            Effect.as<PrefetchResult>({ newPlan: Option.some(p) }),
          ),
        ),
        Effect.orDie,
      )

// ---------------------------------------------------------------------------
// Main loop. State threads through `Loop.next(...)`. One prefetch fiber
// always runs for the next track; the next iteration `Fiber.join`s it
// and folds any returned plan into the plan list.
// ---------------------------------------------------------------------------

type LoopState = {
  readonly cycle: number
  readonly idx: number
  readonly prefetch: Option.Option<Fiber.Fiber<PrefetchResult>>
  readonly plans: ReadonlyArray<TrackPlan>
}

export const runStation = (cfg: RunStationConfig) =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Plan track 0 upfront — we need something to play before the loop
      // body's prefetch can warm the next slot.
      const first = yield* planTrack(cfg.brief, 0, cfg.trackCount, [], cfg.plannerModel)

      const initial: LoopState = {
        cycle: 0,
        idx: 0,
        prefetch: Option.none(),
        plans: [first],
      }

      const v = value<ServerEvent>

      const body = (state: LoopState) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // 1. Wait for THIS track's prefetch (gen + maybe plan).
            const fiberResult = yield* Option.match(state.prefetch, {
              onNone: () => Effect.succeed<PrefetchResult>({ newPlan: Option.none() }),
              onSome: Fiber.join,
            })
            const plans = Option.match(fiberResult.newPlan, {
              onNone: () => state.plans,
              onSome: (p) => [...state.plans, p],
            })

            // 2. Kick prefetch for the NEXT track.
            const nextIdx = (state.idx + 1) % cfg.trackCount
            const fiber = yield* Effect.forkChild(prefetch(cfg, nextIdx, plans))

            // 3. Emit: optional track-planned (if the fiber we just joined
            //    produced a new plan), track-start, audio chunks, track-end,
            //    then await the consumer's ack before threading state into
            //    Loop.next.
            const currentPlan = plans[state.idx]!
            const upfrontEvents: ReadonlyArray<ServerEvent> = Option.match(fiberResult.newPlan, {
              onNone: () => [
                {
                  type: "track-start",
                  index: state.idx,
                  cycle: state.cycle,
                  title: currentPlan.title,
                },
              ],
              onSome: (p) => [
                { type: "track-planned", index: state.idx, title: p.title },
                {
                  type: "track-start",
                  index: state.idx,
                  cycle: state.cycle,
                  title: currentPlan.title,
                },
              ],
            })

            return Stream.fromIterable(upfrontEvents).pipe(
              Stream.map(v),
              Stream.concat(
                trackStream(currentPlan, state.idx, cfg.tracksDir, cfg.musicModel).pipe(
                  Stream.map((bytes) => v({ type: "data", bytes })),
                ),
              ),
              Stream.concat(Stream.succeed(v({ type: "track-end", index: state.idx }))),
              Stream.concat(Stream.fromEffect(cfg.waitTrackEnded).pipe(Stream.drain)),
              Stream.concat(
                next<LoopState>({
                  cycle: nextIdx === 0 ? state.cycle + 1 : state.cycle,
                  idx: nextIdx,
                  prefetch: Option.some(fiber),
                  plans,
                }),
              ),
            )
          }),
        )

      // Up-front events before the first loop iteration.
      const startup = Stream.fromIterable<ServerEvent>([
        { type: "station-info", brief: cfg.brief, total: cfg.trackCount },
        { type: "track-planned", index: 0, title: first.title },
      ])

      return Stream.concat(startup, loop(initial, body))
    }),
  )
