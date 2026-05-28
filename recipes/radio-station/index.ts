/**
 * AI radio station. An LLM plans an N-track station from a brief
 * (Responses + structured output); each track is generated with
 * ElevenLabs Music streaming and tee'd chunk-by-chunk into both the
 * client WebSocket and an on-disk MP3 cache. The station loops
 * forever — cycle 2+ replays from the cache for free.
 *
 * Pipelining: one background prefetch fiber always runs one track
 * ahead of playback. By the time the current track ends, the next is
 * already on disk and streams from cache instantly.
 *
 * The data path never drains inside the producer. `trackStream`
 * returns a `Stream<Uint8Array>`; the WS sender and the prefetcher
 * are the only places where bytes flow out (drain to WS or to /dev/null).
 */
import { Effect, Exit, Fiber, Option, Ref, Schema, Stream } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import { turn } from "@effect-uai/core/LanguageModel"
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

export type ClientEvent = { readonly type: "track-ended" }

// Runtime-specific file ops. The runner (`run-bun.ts`, future
// `run-node.ts`, ...) supplies an implementation; the recipe body
// never touches `Bun.*` / `node:fs/promises` directly.
export type FileWriter = {
  readonly write: (chunk: Uint8Array) => void
  readonly end: Effect.Effect<void>
}

export type FileSystemHooks = {
  readonly exists: (path: string) => Effect.Effect<boolean>
  readonly readStream: (path: string) => Stream.Stream<Uint8Array, AiError.AiError>
  readonly openWriter: (path: string) => Effect.Effect<FileWriter>
  readonly rename: (from: string, to: string) => Effect.Effect<void>
  readonly unlink: (path: string) => Effect.Effect<void>
}

export type RunStationConfig = {
  readonly brief: string
  readonly trackCount: number
  readonly tracksDir: string
  readonly plannerModel: string
  readonly musicModel: string
  readonly fs: FileSystemHooks
  readonly send: (event: ServerEvent) => Effect.Effect<void>
  readonly sendBytes: (bytes: Uint8Array) => Effect.Effect<void>
  /** Resolves once when the client posts `{type:"track-ended"}`. */
  readonly waitTrackEnded: Effect.Effect<void>
}

// ---------------------------------------------------------------------------
// Producer: returns a Stream<Uint8Array>. Does not drain.
//
// Cache lives inside the stream: file exists → read it; otherwise →
// generate, tee'd into the runtime's writer as chunks flow. The writer
// is a scoped resource — on success the .partial file is renamed to
// the final path; on failure/interrupt it's removed so the next
// attempt doesn't read a half-written file as a cache hit.
// ---------------------------------------------------------------------------

const trackStream = (
  plan: TrackPlan,
  index: number,
  tracksDir: string,
  musicModel: string,
  fs: FileSystemHooks,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const file = `${tracksDir}/track-${index}.mp3`

      if (yield* fs.exists(file)) {
        return fs.readStream(file)
      }

      const partial = `${file}.partial`
      const writer = yield* Effect.acquireRelease(fs.openWriter(partial), (w, exit) =>
        w.end.pipe(
          Effect.flatMap(() =>
            Exit.isSuccess(exit) ? fs.rename(partial, file) : fs.unlink(partial),
          ),
        ),
      )

      return MusicGenerator.streamGeneration({
        model: musicModel,
        prompt: plan.prompt,
        outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
      }).pipe(
        Stream.map((c) => c.bytes),
        Stream.tap((bytes) => Effect.sync(() => writer.write(bytes))),
      )
    }),
  )

// ---------------------------------------------------------------------------
// Two consumers. Neither lives inside the producer.
// ---------------------------------------------------------------------------

const prefetchToDisk = (plan: TrackPlan, index: number, cfg: RunStationConfig) =>
  trackStream(plan, index, cfg.tracksDir, cfg.musicModel, cfg.fs).pipe(Stream.runDrain)

const sendToClient = (plan: TrackPlan, index: number, cycle: number, cfg: RunStationConfig) =>
  Effect.gen(function* () {
    yield* cfg.send({ type: "track-start", index, cycle, title: plan.title })
    yield* trackStream(plan, index, cfg.tracksDir, cfg.musicModel, cfg.fs).pipe(
      Stream.tap(cfg.sendBytes),
      Stream.runDrain,
    )
    yield* cfg.send({ type: "track-end", index })
  })

// ---------------------------------------------------------------------------
// Main loop: one prefetch fiber always running for the next track.
// Fiber.join before opening a track's stream prevents a race where the
// sender and prefetcher both hit the gen path for the same uncached file.
// ---------------------------------------------------------------------------

export const runStation = (cfg: RunStationConfig) =>
  Effect.gen(function* () {
    yield* cfg.send({ type: "station-info", brief: cfg.brief, total: cfg.trackCount })

    // Plan + announce track 0 upfront — we need something to play before
    // the loop body's prefetch can warm the next slot.
    const first = yield* planTrack(cfg.brief, 0, cfg.trackCount, [], cfg.plannerModel)
    const plans = yield* Ref.make<ReadonlyArray<TrackPlan>>([first])
    yield* cfg.send({ type: "track-planned", index: 0, title: first.title })

    const prefetch = yield* Ref.make<Option.Option<Fiber.Fiber<void, unknown>>>(Option.none())
    const state = yield* Ref.make({ cycle: 0, idx: 0 })

    yield* Effect.forever(
      Effect.gen(function* () {
        const { cycle, idx } = yield* Ref.get(state)

        // 1. Wait for THIS track's prefetch (plan + gen) to land, if any.
        yield* Ref.get(prefetch).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Fiber.join })),
        )

        // 2. Kick prefetch for the NEXT track: plan (cycle 0 only) + gen.
        const nextIdx = (idx + 1) % cfg.trackCount
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            const so_far = yield* Ref.get(plans)
            // Cycle 0 fills the plan list as we go; cycle 1+ reuses it.
            if (nextIdx >= so_far.length) {
              const plan = yield* planTrack(
                cfg.brief,
                nextIdx,
                cfg.trackCount,
                so_far,
                cfg.plannerModel,
              )
              yield* Ref.update(plans, (ps) => [...ps, plan])
              yield* cfg.send({ type: "track-planned", index: nextIdx, title: plan.title })
            }
            const ps = yield* Ref.get(plans)
            yield* prefetchToDisk(ps[nextIdx]!, nextIdx, cfg)
          }),
        )
        yield* Ref.set(prefetch, Option.some(fiber))

        // 3. Stream THIS track to the client.
        const ps = yield* Ref.get(plans)
        yield* sendToClient(ps[idx]!, idx, cycle, cfg)

        // 4. Backpressure on actual listening time.
        yield* cfg.waitTrackEnded

        yield* Ref.set(state, { cycle: nextIdx === 0 ? cycle + 1 : cycle, idx: nextIdx })
      }),
    )
  })
