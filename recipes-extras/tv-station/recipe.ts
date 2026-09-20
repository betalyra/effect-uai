/**
 * AI TV station. An LLM invents a channel nobody has made before, plans
 * its running order a few segments at a time, and each segment becomes a
 * short clip through the generic `VideoGenerator` tag.
 *
 * Every state change is written to the manifest before the next wire
 * call, so a crash between `submit` and `collect` loses nothing: the
 * restart finds the job ref on disk and collects a run that is still
 * going on the provider's side. That is why this drives `submit` and
 * `status` separately rather than through one blocking call.
 *
 * Shape: `runStation` hands back the picture as one byte stream and what
 * is happening to it as a stream of events. The browser plays the first
 * and reads the second; it decides nothing.
 */
import {
  Array as Arr,
  Cause,
  Duration,
  Effect,
  Encoding,
  FileSystem,
  Match,
  Option,
  Queue,
  Ref,
  Stream,
} from "effect"
import { HttpClient } from "effect/unstable/http"
import type * as AiError from "@effect-uai/core/AiError"
import * as Job from "@effect-uai/core/Job"
import type { LanguageModel } from "@effect-uai/core/LanguageModel"
import * as VideoDownload from "@effect-uai/core/VideoDownload"
import * as ImageGenerator from "@effect-uai/core/ImageGenerator"
import * as VideoGenerator from "@effect-uai/core/VideoGenerator"
import type { Card, PlanError } from "./planner.js"
import { deal, planSegment, planStandby } from "./planner.js"
import * as Station from "./station.js"
import type { Broadcast, ClipRejected } from "./stream.js"
import { assemble, broadcast } from "./stream.js"

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export type ServerEvent =
  | {
      readonly type: "station-info"
      readonly channel: string
      readonly tagline: string
      /** `null` under `--infinite`, where the running order has no end. */
      readonly total: number | null
    }
  | {
      readonly type: "clip-planned"
      readonly index: number
      readonly kind: string
      readonly title: string
    }
  | { readonly type: "clip-ready"; readonly index: number }
  | {
      readonly type: "clip-start"
      readonly index: number
      readonly cycle: number
      readonly title: string
    }
  /** The standby card is on screen: the next clip is still rendering. */
  | { readonly type: "standby"; readonly index: number }

export type RunStationConfig = {
  readonly station: Station.Station
  readonly manifest: string
  readonly clipsDir: string
  readonly plannerModel: string
  readonly imageModel: string
  /** Ignore the budget. Not on the manifest, because JSON has no infinity. */
  readonly infinite: boolean
  /** Start the running order again instead of stopping at the end. */
  readonly loop: boolean
  /** Replay the clips already on disk as if they were rendering. Nothing is generated or written. */
  readonly rehearse: boolean
}

/** The fast tier renders a six second clip in about three, so poll like it. */
const POLL: Job.JobConfig = { pollInterval: "1 second", timeout: "5 minutes" }

type Notices = Queue.Queue<ServerEvent, Cause.Done>

/** The manifest is the producer's alone; playback only reads what it is handed. */
type Board = Ref.Ref<Station.Station>

// ---------------------------------------------------------------------------
// Rendering one clip
//
// The order here is the whole point. `submit` returns a ref, the ref
// reaches disk, and only then does polling start. Any other order leaves
// a crash window where the provider is rendering something this process
// can no longer claim, and the restart pays for it twice.
// ---------------------------------------------------------------------------

/** Where a rendered clip is recorded. The interlude lives beside the running order. */
type Slot = {
  readonly file: string
  readonly save: (clip: Station.Clip) => Effect.Effect<void, never, FileSystem.FileSystem>
}

/**
 * Record a change to the station and put it on disk. Takes a function
 * rather than a finished station: the producer and the standby card
 * write from separate fibers, and a read followed by a write would let
 * one drop what the other had just recorded.
 */
const persist = (
  cfg: RunStationConfig,
  board: Board,
  change: (station: Station.Station) => Station.Station,
) =>
  Effect.flatMap(Ref.updateAndGet(board, change), (next) =>
    // A rehearsal's board is a fiction and must never reach the manifest.
    cfg.rehearse ? Effect.void : Station.write(cfg.manifest, next),
  )

const inOrder = (cfg: RunStationConfig, board: Board, index: number): Slot => ({
  file: `clip-${index}.mp4`,
  save: (clip) => persist(cfg, board, (station) => Station.withClip(station, clip)),
})

const start = (cfg: RunStationConfig, slot: Slot, clip: Station.Clip) =>
  Effect.gen(function* () {
    const ref = yield* VideoGenerator.submit({
      model: cfg.station.model,
      prompt: clip.prompt,
      duration: Duration.seconds(clip.seconds),
      aspectRatio: "16:9",
    })
    yield* slot.save({ ...clip, state: { _tag: "submitted", ref } })
    return ref
  })

/** fal returns the card inline under `sync_mode`, so there is nothing to fetch. */
const firstImage = (response: ImageGenerator.ImageResponse): Effect.Effect<Uint8Array> =>
  Option.match(Arr.head(response.images), {
    onNone: () => Effect.die(new Error("the provider returned no image")),
    onSome: (image) =>
      Match.value(image.image).pipe(
        Match.tag("bytes", (i) => Effect.succeed(i.bytes)),
        Match.tag("base64", (i) =>
          Effect.orDie(Effect.fromResult(Encoding.decodeBase64(i.base64))),
        ),
        Match.tag("url", () => Effect.die(new Error("the image came back as a link"))),
        Match.exhaustive,
      ),
  })

/** `collect` settles or fails; an empty result is already a failed job. */
const firstVideo = (response: VideoGenerator.VideoResponse) =>
  Option.match(Arr.head(response.videos), {
    onNone: () => Effect.die(new Error("the provider settled with no video")),
    onSome: Effect.succeed,
  })

const writeClip = (
  path: string,
  bytes: Uint8Array,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFile(`${path}.partial`, bytes)
    yield* fs.rename(`${path}.partial`, path)
  }).pipe(Effect.orDie)

const finish = (
  cfg: RunStationConfig,
  slot: Slot,
  clip: Station.Clip,
  ref: VideoGenerator.VideoJobRef,
) =>
  Effect.gen(function* () {
    const response = yield* VideoGenerator.collect(ref, POLL)
    const video = yield* firstVideo(response)
    const downloaded = yield* VideoDownload.download(video.video)
    yield* writeClip(`${cfg.clipsDir}/${slot.file}`, downloaded.bytes)
    const done: Station.Clip = { ...clip, state: { _tag: "done", file: slot.file } }
    yield* slot.save(done)
    return done
  })

/**
 * A ref read back from JSON has lost its result type, which is why
 * `Job.JobRef`'s docs say to narrow at the call site that knows the
 * capability. This is that call site.
 */
const resume = (state: Station.ClipState & { readonly _tag: "submitted" }) =>
  Job.jobRef<VideoGenerator.VideoResponse>(state.ref.provider, state.ref.id)

const render = (cfg: RunStationConfig, slot: Slot, clip: Station.Clip) =>
  Effect.gen(function* () {
    const state = clip.state
    if (state._tag === "done") return clip
    const ref = state._tag === "submitted" ? resume(state) : yield* start(cfg, slot, clip)
    return yield* finish(cfg, slot, clip, ref)
  })

// ---------------------------------------------------------------------------
// Producer
//
// One fiber, sequential. Concurrency would not help: the first clip is a
// cold start either way, and after it the producer is already ahead of
// playback.
//
// `notices` carries what the client should know as soon as it is known,
// `ready` carries clips in playing order. Two queues, because only
// playback applies backpressure and a title appearing in the running
// order must not wait on someone watching.
// ---------------------------------------------------------------------------

/** Planning, generating and fetching each have their own way to go wrong. */
type ProduceError = PlanError | AiError.AiError | VideoDownload.DownloadError

type StandbyServices = LanguageModel | ImageGenerator.ImageGenerator | FileSystem.FileSystem

type ProduceServices =
  | LanguageModel
  | VideoGenerator.VideoGenerator
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ImageGenerator.ImageGenerator

/** Slots planned per top-up: enough runway to stay ahead, few enough to start fast. */
const BATCH = 3

/** How many more clips the budget allows. `--infinite` never runs out. */
const roomFor = (infinite: boolean, station: Station.Station): number =>
  infinite
    ? BATCH
    : Math.max(
        0,
        Math.floor((station.budgetSeconds - Station.spentSeconds(station)) / station.clipSeconds),
      )

/** Kinds already dealt recently, so a block cannot repeat a slot. */
const recentKinds = (
  station: Station.Station,
  dealt: ReadonlyArray<Card>,
): ReadonlyArray<string> => [
  ...Arr.takeRight(station.clips, BATCH * 2).map((clip) => clip.kind ?? ""),
  ...dealt.map((c) => c.kind),
]

/** Dealt one at a time so each card can avoid the ones before it. */
const hand = (station: Station.Station, count: number): Effect.Effect<ReadonlyArray<Card>> =>
  Effect.reduce(
    Arr.range(1, count),
    () => [] as ReadonlyArray<Card>,
    (dealt) => Effect.map(deal(recentKinds(station, dealt)), (card) => [...dealt, card]),
  )

const asClips = (
  station: Station.Station,
  cards: ReadonlyArray<Card>,
  segments: ReadonlyArray<{ readonly title: string; readonly prompt: string }>,
): ReadonlyArray<Station.Clip> =>
  segments.map((segment, offset) => ({
    index: station.clips.length + offset,
    kind: cards[offset]?.kind ?? "segment",
    title: segment.title,
    prompt: segment.prompt,
    seconds: station.clipSeconds,
    state: { _tag: "planned" as const },
  }))

/**
 * The next block of the running order, empty once the budget is spent.
 * One model call per slot, run together: the cards already guarantee the
 * slots differ, so they need not see each other.
 *
 * Pure planning: nothing is submitted and nothing is written, so
 * `--dry-run` can call it to show what a run would make.
 */
export const planNext = (
  station: Station.Station,
  plannerModel: string,
  infinite: boolean,
): Effect.Effect<ReadonlyArray<Station.Clip>, PlanError, LanguageModel> =>
  Effect.gen(function* () {
    const count = Math.min(BATCH, roomFor(infinite, station))
    if (count === 0) return [] as ReadonlyArray<Station.Clip>
    const cards = yield* hand(station, count)
    const segments = yield* Effect.forEach(
      cards,
      (card) => planSegment(station, card, plannerModel),
      { concurrency: count },
    )
    return asClips(station, cards, segments)
  })

const topUp = (cfg: RunStationConfig, board: Board, notices: Notices) =>
  Effect.gen(function* () {
    const station = yield* Ref.get(board)
    const clips = yield* planNext(station, cfg.plannerModel, cfg.infinite)
    if (Arr.isReadonlyArrayEmpty(clips)) return clips
    yield* persist(cfg, board, (current) => Station.withClips(current, clips))
    yield* Effect.forEach(
      clips,
      (clip) =>
        Queue.offer(notices, {
          type: "clip-planned",
          index: clip.index,
          kind: clip.kind ?? "segment",
          title: clip.title,
        }),
      { discard: true },
    )
    return clips
  })

/** The clip at `index`, planning a fresh batch when the runway runs out. */
const nextClip = (cfg: RunStationConfig, board: Board, notices: Notices, index: number) =>
  Effect.gen(function* () {
    const known = (yield* Ref.get(board)).clips[index]
    if (known !== undefined) return Option.some(known)
    return Option.fromNullishOr((yield* topUp(cfg, board, notices))[0])
  })

/** The standby card, beside the clips it sits between. */
const STANDBY_CARD = "standby.png"

/**
 * The standby card: an image, generated once, which the broadcast airs
 * whenever the next clip is not ready. A still loops perfectly by
 * construction, which is the whole reason this is a picture rather than
 * a generated video.
 *
 * Deliberately not part of `station.clips`: it costs no budget and never
 * appears in the listing.
 */
const produceStandby = (
  cfg: RunStationConfig,
  board: Board,
): Effect.Effect<void, PlanError | AiError.AiError, StandbyServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const card = `${cfg.clipsDir}/${STANDBY_CARD}`
    if (!(yield* Effect.orDie(fs.exists(card)))) {
      // The prompt was planned with the channel, so only the picture is
      // left to make. A manifest from before that gets one now.
      const station = yield* Ref.get(board)
      const prompt = yield* Option.match(Option.fromNullishOr(station.card), {
        onNone: () => planStandby(station, cfg.plannerModel),
        onSome: Effect.succeed,
      })
      const response = yield* ImageGenerator.generate({
        model: cfg.imageModel,
        prompt,
        aspectRatio: "16:9",
      })
      yield* writeClip(card, yield* firstImage(response))
    }
    yield* persist(cfg, board, (current) => ({ ...current, standby: STANDBY_CARD }))
  })

/** The whole programme as one ordinary file, beside the clips it is made of. */
const PROGRAMME = "programme.mp4"

/**
 * Written once the running order has rendered, so a finished station is
 * a file you can post without pressing anything. `--infinite` never gets
 * here, and `/programme.mp4` still serves whatever exists at any point.
 */
const keepProgramme = (cfg: RunStationConfig, board: Board) =>
  Effect.gen(function* () {
    const station = yield* Ref.get(board)
    const files = station.clips.flatMap((clip) => Option.toArray(fileOf(cfg, clip)))
    if (Arr.isReadonlyArrayEmpty(files)) return
    yield* writeClip(`${cfg.clipsDir}/${PROGRAMME}`, yield* assemble(files))
    yield* Effect.logInfo(`programme saved to ${cfg.clipsDir}/${PROGRAMME}`)
  })

/**
 * Render the running order in order, one clip at a time. Sequential on
 * purpose: generation already outruns playback, and the timeline reads
 * the board rather than a queue, so nothing here has to hand anything on.
 */
const produce = (
  cfg: RunStationConfig,
  board: Board,
  notices: Notices,
  index: number,
): Effect.Effect<void, ProduceError, ProduceServices> =>
  Effect.gen(function* () {
    const planned = yield* nextClip(cfg, board, notices, index)
    if (Option.isNone(planned)) return
    yield* render(cfg, inOrder(cfg, board, index), planned.value)
    yield* Queue.offer(notices, { type: "clip-ready", index })
    return yield* produce(cfg, board, notices, index + 1)
  })

/** Seconds between clips coming ready in a rehearsal: long enough to see the card. */
const REVEAL = Duration.seconds(8)

/**
 * A rehearsal: the clips already on disk come ready one at a time, as if
 * they were rendering, so the whole station can be watched again without
 * a single generation. The card is the one on disk too.
 */
const rehearse = (cfg: RunStationConfig, board: Board, notices: Notices): Effect.Effect<void> =>
  Effect.gen(function* () {
    const rendered = cfg.station.clips
      .filter((clip) => clip.state._tag === "done")
      .map((clip, index) => ({ ...clip, index }))
    yield* Ref.set(board, {
      ...cfg.station,
      clips: rendered.map((clip) => ({ ...clip, state: { _tag: "planned" as const } })),
    })
    yield* Effect.forEach(
      rendered,
      (clip) =>
        Queue.offer(notices, {
          type: "clip-planned",
          index: clip.index,
          kind: clip.kind ?? "segment",
          title: clip.title,
        }),
      { discard: true },
    )
    yield* Effect.forEach(
      rendered,
      (clip) =>
        Effect.sleep(REVEAL).pipe(
          Effect.andThen(Ref.update(board, (station) => Station.withClip(station, clip))),
          Effect.andThen(Queue.offer(notices, { type: "clip-ready", index: clip.index })),
        ),
      { discard: true },
    )
  })

// ---------------------------------------------------------------------------
// The timeline
//
// One continuous video, paced against the wall clock. The stitcher is
// happy to read every clip off disk as fast as the disk allows, which
// would hand the browser the whole programme at once and leave nothing to
// fill; pacing is what makes this a channel rather than a download.
//
// At each boundary the question is "what plays now". The answer is the
// next clip if it has finished rendering, and the interlude if it has
// not, which is the whole of the filler logic.
// ---------------------------------------------------------------------------

/**
 * Seconds of video kept ahead of the viewer. Enough to decode and encode
 * a clip (well under a second) and finish a fragment; no more, since
 * whatever is aired now is on screen this much later.
 */
const LEAD = Duration.seconds(2)

/** Seconds of still per hold: how long after a clip lands the card can linger. */
const HOLD_SECONDS = 1

const fileOf = (cfg: RunStationConfig, clip: Station.Clip): Option.Option<string> =>
  clip.state._tag === "done" ? Option.some(`${cfg.clipsDir}/${clip.state.file}`) : Option.none()

/** The clip at `index`, if it has rendered. */
const readyAt = (board: Board, cfg: RunStationConfig, index: number) =>
  Effect.map(Ref.get(board), (station) =>
    Option.flatMap(Option.fromNullishOr(station.clips[index]), (clip) =>
      Option.map(fileOf(cfg, clip), (file) => ({ clip, file })),
    ),
  )

/**
 * Sleep until the broadcast is only `LEAD` ahead of real time. `aired` is
 * where the timeline has reached; the difference from the elapsed clock is
 * how far ahead we have run.
 */
const pace = (startedAt: number, aired: number) =>
  Effect.sleep(
    Duration.max(
      Duration.zero,
      Duration.subtract(
        Duration.seconds(aired),
        Duration.sum(Duration.millis(Date.now() - startedAt), LEAD),
      ),
    ),
  )

/** The card, once it has been generated. */
const standbyAt = (board: Board, cfg: RunStationConfig): Effect.Effect<Option.Option<string>> =>
  Effect.map(Ref.get(board), (station) =>
    Option.map(Option.fromNullishOr(station.standby), (file) => `${cfg.clipsDir}/${file}`),
  )

/** What the timeline does at a boundary. */
type Cue =
  | {
      readonly _tag: "air"
      readonly index: number
      readonly wrapped: boolean
      readonly clip: Station.Clip
      readonly file: string
    }
  /** The next clip is still rendering: the card covers the wait. */
  | { readonly _tag: "hold" }
  /** The running order is finished and not looping. */
  | { readonly _tag: "over" }

/**
 * What plays at `index`.
 *
 * A clip that has not rendered is not the end of the running order, only
 * a clip that is late, so wrapping waits on the producer being finished.
 * Reading "nothing ready here" as "nothing left" would replay clip zero
 * every time playback caught up with generation.
 */
const cueAt = (
  cfg: RunStationConfig,
  board: Board,
  spent: Ref.Ref<boolean>,
  index: number,
): Effect.Effect<Cue> =>
  Effect.gen(function* () {
    const next = yield* readyAt(board, cfg, index)
    if (Option.isSome(next)) return { _tag: "air", index, wrapped: false, ...next.value }
    if (!(yield* Ref.get(spent))) return { _tag: "hold" }
    if (!cfg.loop) return { _tag: "over" }
    return yield* Effect.map(readyAt(board, cfg, 0), (first) =>
      Option.match(first, {
        onNone: (): Cue => ({ _tag: "over" }),
        onSome: (item): Cue => ({ _tag: "air", index: 0, wrapped: true, ...item }),
      }),
    )
  })

const timeline = (
  cfg: RunStationConfig,
  board: Board,
  cast: Broadcast,
  notices: Notices,
  spent: Ref.Ref<boolean>,
  startedAt: number,
) => {
  const step = (index: number, cycle: number, aired: number): Effect.Effect<void, ClipRejected> =>
    Effect.gen(function* () {
      yield* pace(startedAt, aired)
      const cue = yield* cueAt(cfg, board, spent, index)
      return yield* Match.value(cue).pipe(
        Match.tag("over", () => Effect.void),
        Match.tag("hold", () => hold(index, cycle, aired)),
        Match.tag("air", (on) =>
          Effect.gen(function* () {
            const round = on.wrapped ? cycle + 1 : cycle
            yield* Queue.offer(notices, {
              type: "clip-start",
              index: on.index,
              cycle: round,
              title: on.clip.title,
            })
            const length = yield* cast.append(on.file)
            return yield* step(on.index + 1, round, aired + length)
          }),
        ),
        Match.exhaustive,
      )
    })

  /**
   * The still goes out through the same encoder as the clips, which is
   * why holding needs no special case downstream and no logic in the
   * browser at all. Before the card exists the still is black, so the
   * picture starts the moment Play is pressed.
   */
  const hold = (index: number, cycle: number, aired: number): Effect.Effect<void, ClipRejected> =>
    Effect.gen(function* () {
      const card = yield* standbyAt(board, cfg)
      yield* Option.match(card, { onNone: () => Effect.void, onSome: cast.show })
      yield* Queue.offer(notices, { type: "standby", index })
      const held = yield* cast.hold(HOLD_SECONDS)
      return yield* step(index, cycle, aired + held)
    })

  return step(0, 0, 0)
}

const stationInfo = (cfg: RunStationConfig): ServerEvent => ({
  type: "station-info",
  channel: cfg.station.channel,
  tagline: cfg.station.tagline,
  total: cfg.infinite ? null : Math.floor(cfg.station.budgetSeconds / cfg.station.clipSeconds),
})

/** What a viewer attaches to: the picture, and what is happening to it. */
export type LiveStation = {
  /** The picture from byte `from` on. A browser asks for it in pieces, by byte range. */
  readonly tap: (from: number) => Stream.Stream<Uint8Array, ClipRejected>
  readonly events: Stream.Stream<ServerEvent>
}

/**
 * Start the channel: render the running order in one fiber, the standby
 * card in another, air them in a third, and hand back what a viewer
 * attaches to. The broadcast opens at once, so the picture is on before
 * anything has rendered.
 *
 * Every fiber is a child of the caller, so closing the page tears the
 * whole station down. Nothing begins until this is called, which is what
 * makes the Play button mean something.
 */
export const runStation = (
  cfg: RunStationConfig,
): Effect.Effect<LiveStation, ClipRejected, ProduceServices> =>
  Effect.gen(function* () {
    const board = yield* Ref.make(cfg.station)
    const notices = yield* Queue.unbounded<ServerEvent, Cause.Done>()

    // A provider failure stops production rather than killing the run:
    // whatever already rendered is still worth watching, and the manifest
    // still holds the rest.
    const reporting =
      (what: string) =>
      <A, E, R>(work: Effect.Effect<A, E, R>) =>
        work.pipe(
          Effect.tapCause((cause) =>
            Effect.logError(`[${what}] stopped`, { cause: Cause.pretty(cause) }),
          ),
          Effect.ignore,
        )

    // Set once the producer can add nothing further, whether it ran out
    // of budget or gave up. Until then an unrendered clip is late rather
    // than missing, and that is the difference between the card and a
    // wrap back to the top.
    const spent = yield* Ref.make(false)

    const production = cfg.rehearse
      ? rehearse(cfg, board, notices)
      : Effect.andThen(
          Effect.ensuring(produce(cfg, board, notices, 0), Ref.set(spent, true)),
          keepProgramme(cfg, board),
        )
    yield* Effect.forkChild(
      production.pipe(Effect.ensuring(Ref.set(spent, true)), reporting("producer")),
    )
    yield* Effect.forkChild(produceStandby(cfg, board).pipe(reporting("standby")))

    // The picture, not production, decides when the channel is over:
    // under `--loop` the producer finishes long before the timeline does.
    const cast = yield* broadcast
    yield* Effect.forkChild(
      timeline(cfg, board, cast, notices, spent, Date.now()).pipe(
        reporting("timeline"),
        Effect.ensuring(Effect.andThen(cast.close, Queue.end(notices))),
      ),
    )

    return {
      tap: cast.tap,
      events: Stream.concat(Stream.succeed(stationInfo(cfg)), Stream.fromQueue(notices)),
    }
  })
