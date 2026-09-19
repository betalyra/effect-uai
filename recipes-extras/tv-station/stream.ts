/**
 * Joining clips into one continuous video.
 *
 *   broadcast - one fragmented MP4 written to an open HTTP response, forever
 *   assemble  - the rendered clips as one ordinary seekable MP4, for keeping
 *
 * A progressive MP4 states each track's codec configuration once, in a
 * header the player reads before the first frame, so a stream that
 * changes encoder settings midway is undecodable from that point on.
 * Clips arrive with whatever settings the provider chose, and no still
 * image can be encoded to match them. The broadcast therefore decodes
 * everything, clips and card alike, and runs one encoder for the whole
 * channel: one configuration by construction, and a card that needs no
 * clip to be shaped after.
 *
 * `assemble` is the exception. It copies the clips' packets untouched,
 * never decoding a frame, because a file on disk can carry several
 * configurations and a download wants the original quality.
 *
 * FFmpeg does the decoding and reshaping through `node-av`; mediabunny
 * encodes and muxes, with `@mediabunny/server` supplying its codecs.
 * That is what `recipes-extras` is for.
 */
import { Array as Arr, Data, Effect, Option, Ref, type Scope, Stream } from "effect"
import {
  AvFrameAudioSampleResource,
  AvFrameVideoSampleResource,
  registerMediabunnyServer,
} from "@mediabunny/server"
import {
  AV_LOG_ERROR,
  Decoder,
  Demuxer,
  FilterAPI,
  type Frame,
  Log,
  Rational,
  type Stream as AvStream,
} from "node-av"
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FilePathSource,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
  VideoSample,
  VideoSampleSource,
} from "mediabunny"

/** A clip that could not be read, or could not be written to the stream. */
export class ClipRejected extends Data.TaggedError("ClipRejected")<{
  readonly file: string
  readonly reason: string
}> {
  override get message() {
    return `${this.file}: ${this.reason}`
  }
}

/** A write to an output the viewer has already gone from rejects with nothing at all. */
const rejected = (file: string) => (cause: unknown) =>
  new ClipRejected({
    file,
    reason: Option.match(Option.fromNullishOr(cause), {
      onNone: () => "the output was gone",
      onSome: String,
    }),
  })

const refuse = (file: string, reason: string) => Effect.fail(new ClipRejected({ file, reason }))

/**
 * Releasing a foreign handle, whether it closes synchronously or not.
 * A handle that objects to being released has nothing left to tell us,
 * so this swallows defects as well as failures.
 */
const closing = (close: () => unknown): Effect.Effect<void> =>
  Effect.ignoreCause(Effect.promise(async () => close()))

/**
 * Teaches mediabunny to encode, which it cannot do alone outside a
 * browser: neither Node nor Bun has WebCodecs. Called once at startup.
 */
export const registerCodecs: Effect.Effect<void> = Effect.sync(() => {
  // Software only. The hardware probe fails loudly on every codec it
  // tries and falls back anyway, and software already outruns real time.
  registerMediabunnyServer({ hardwareContext: null })
  Log.setLevel(AV_LOG_ERROR)
})

// ---------------------------------------------------------------------------
// The house format
//
// Everything on air is reshaped to this before it meets the encoder, so
// the stream never has to know what the provider produced.
// ---------------------------------------------------------------------------

const HOUSE = { width: 1280, height: 720, frameRate: 24, sampleRate: 48000, channels: 2 }

/** Letterbox into the frame, lock the rate, and hand the encoder planar 4:2:0. */
const VIDEO_GRAPH =
  `scale=${HOUSE.width}:${HOUSE.height}:force_original_aspect_ratio=decrease,` +
  `pad=${HOUSE.width}:${HOUSE.height}:-1:-1,fps=${HOUSE.frameRate},format=yuv420p`

/** Interleaved float stereo at the house rate. */
const AUDIO_GRAPH = `aresample=${HOUSE.sampleRate},aformat=sample_fmts=flt:channel_layouts=stereo`

const FRAME = 1 / HOUSE.frameRate

// ---------------------------------------------------------------------------
// Decoding through FFmpeg
// ---------------------------------------------------------------------------

const demuxed = (file: string): Effect.Effect<Demuxer, ClipRejected, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => Demuxer.open(file), catch: rejected(file) }),
    (open) => closing(() => open.close()),
  )

/** Software decoding: the hardware probe fails noisily on every clip and falls back anyway. */
const decoded = (
  file: string,
  stream: AvStream,
): Effect.Effect<Decoder, ClipRejected, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => Decoder.create(stream, { hardware: null }),
      catch: rejected(file),
    }),
    (open) => closing(() => open.close()),
  )

const filtered = (graph: string): Effect.Effect<FilterAPI, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => FilterAPI.create(graph)),
    (open) => Effect.sync(() => open.close()),
  )

/** FFmpeg yields `null` while it is still filling its pipeline. */
const frames = (file: string, source: AsyncIterable<Frame | null>) =>
  Stream.fromAsyncIterable(source, rejected(file)).pipe(
    Stream.filter((frame): frame is Frame => frame !== null),
  )

/**
 * A decoded frame belongs to FFmpeg and is reused for the next one, so
 * the bytes are copied out before anything downstream may hold on to
 * them. `frame` is only borrowed here.
 */
const ownedVideo = (frame: Frame): Effect.Effect<VideoSample> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      // A still read from a PNG carries no pixel aspect ratio, which
      // mediabunny reads as a frame of zero height.
      frame.sampleAspectRatio = new Rational(1, 1)
      return new VideoSample(new AvFrameVideoSampleResource(frame), {
        codedWidth: HOUSE.width,
        codedHeight: HOUSE.height,
        timestamp: 0,
        duration: FRAME,
      })
    }),
    (native) =>
      Effect.promise(async () => {
        const bytes = new Uint8Array(native.allocationSize())
        await native.copyTo(bytes)
        return new VideoSample(bytes, {
          format: "I420",
          codedWidth: HOUSE.width,
          codedHeight: HOUSE.height,
          timestamp: 0,
          duration: FRAME,
        })
      }),
    (native) => Effect.sync(() => native.close()),
  )

const ownedAudio = (frame: Frame): Effect.Effect<AudioSample> =>
  Effect.acquireUseRelease(
    Effect.sync(() => new AudioSample(new AvFrameAudioSampleResource(frame))),
    (native) =>
      Effect.sync(() => {
        const bytes = new Uint8Array(native.allocationSize({ planeIndex: 0 }))
        native.copyTo(bytes, { planeIndex: 0 })
        return new AudioSample({
          data: bytes,
          format: native.format,
          numberOfChannels: native.numberOfChannels,
          sampleRate: native.sampleRate,
          timestamp: 0,
        })
      }),
    (native) => Effect.sync(() => native.close()),
  )

// ---------------------------------------------------------------------------
// The encoder
// ---------------------------------------------------------------------------

type Encoder = {
  readonly video: VideoSampleSource
  readonly audio: AudioSampleSource
}

type Sample = { readonly timestamp: number; readonly duration: number; close(): void }

/** Frames between forced keyframes: two a second. */
const KEY_EVERY = HOUSE.frameRate / 2

/**
 * A fragment can only begin at a keyframe, and a browser reading one has
 * to hop between its video and audio, so a long stretch without a
 * keyframe becomes a fragment too big to hop across. Every frame sits on
 * the house grid, so the decision is made from the timestamp alone.
 */
const addVideo = (encoder: Encoder) => (sample: VideoSample) =>
  encoder.video.add(sample, { keyFrame: Math.round(sample.timestamp / FRAME) % KEY_EVERY === 0 })

/**
 * Hand a sample we own to the encoder and report where it ends. Closed
 * here whatever happens, since nothing else will see it again.
 */
const played =
  <S extends Sample>(file: string, add: (sample: S) => Promise<void>) =>
  (sample: S): Effect.Effect<number, ClipRejected> =>
    Effect.acquireUseRelease(
      Effect.succeed(sample),
      (owned) =>
        Effect.as(
          Effect.tryPromise({ try: () => add(owned), catch: rejected(file) }),
          owned.timestamp + owned.duration,
        ),
      (owned) => Effect.sync(() => owned.close()),
    )

const latest = Stream.runFold(
  () => 0,
  (end: number, at: number) => Math.max(end, at),
)

/** Silence at a time, so a long stretch is still a handful of samples. */
const SILENCE_STEP = 1

/**
 * Silence from `from` to `to`. The audio track has to advance with the
 * video or a player stalls on the gap, and nothing has to be heard for
 * that, so this is zeroes in the house format.
 */
const silence = (encoder: Encoder, from: number, to: number): Effect.Effect<number, ClipRejected> =>
  Stream.fromIterable(Arr.range(0, Math.ceil((to - from) / SILENCE_STEP) - 1)).pipe(
    Stream.map((index) => {
      const at = from + index * SILENCE_STEP
      const span = Math.min(SILENCE_STEP, to - at)
      return new AudioSample({
        data: new Float32Array(Math.round(span * HOUSE.sampleRate) * HOUSE.channels),
        format: "f32",
        numberOfChannels: HOUSE.channels,
        sampleRate: HOUSE.sampleRate,
        timestamp: at,
      })
    }),
    Stream.mapEffect(played("silence", (sample) => encoder.audio.add(sample))),
    latest,
    Effect.map((end) => Math.max(end, to)),
  )

/**
 * Air a whole clip from `offset`, and report how far it reached. Video
 * frames are placed on the house frame grid and audio by its sample
 * count, so neither depends on what FFmpeg says about time. A clip whose
 * sound stops short, or that has none, is padded with silence to its
 * picture: the two tracks must end together.
 */
const conform = (
  encoder: Encoder,
  file: string,
  offset: number,
): Effect.Effect<number, ClipRejected> =>
  Effect.scoped(
    Effect.gen(function* () {
      // One demuxer per track. Two readers on one demuxer share its end
      // of file, and the sound is done long before the picture.
      const demuxer = yield* demuxed(file)
      const picture = yield* Option.match(Option.fromNullishOr(demuxer.video()), {
        onNone: () => refuse(file, "it has no video track"),
        onSome: Effect.succeed,
      })
      const again = yield* demuxed(file)
      const sound = Option.fromNullishOr(again.audio())

      const video = Effect.gen(function* () {
        const decoder = yield* decoded(file, picture)
        const graph = yield* filtered(VIDEO_GRAPH)
        return yield* frames(
          file,
          graph.frames(decoder.frames(demuxer.packets(picture.index))),
        ).pipe(
          Stream.mapEffect(ownedVideo),
          Stream.zipWithIndex,
          Stream.map(([sample, index]) => {
            sample.setTimestamp(offset + index * FRAME)
            return sample
          }),
          Stream.mapEffect(played(file, addVideo(encoder))),
          latest,
        )
      })

      const audio = Option.match(sound, {
        onNone: () => Effect.succeed(offset),
        onSome: (stream) =>
          Effect.gen(function* () {
            const decoder = yield* decoded(file, stream)
            const graph = yield* filtered(AUDIO_GRAPH)
            return yield* frames(
              file,
              graph.frames(decoder.frames(again.packets(stream.index))),
            ).pipe(
              Stream.mapEffect(ownedAudio),
              Stream.mapAccum(
                () => 0,
                (count, sample) => {
                  sample.setTimestamp(offset + count / HOUSE.sampleRate)
                  return [count + sample.numberOfFrames, [sample]] as const
                },
              ),
              Stream.mapEffect(played(file, (sample) => encoder.audio.add(sample))),
              latest,
            )
          }),
      })

      const [seen, heard] = yield* Effect.all([video, audio], { concurrency: 2 })
      const end = heard < seen ? yield* silence(encoder, heard, seen) : heard
      return Math.max(seen, end) - offset
    }),
  )

// ---------------------------------------------------------------------------
// The still
// ---------------------------------------------------------------------------

/** What `hold` airs: black until a card has been shown. */
type Still = {
  readonly card: Option.Option<string>
  readonly picture: VideoSample
}

/** Video black: 16 in luma, 128 in both chroma planes. */
const blank = (): VideoSample => {
  const luma = HOUSE.width * HOUSE.height
  const data = new Uint8Array(luma + luma / 2)
  data.fill(16, 0, luma)
  data.fill(128, luma)
  return new VideoSample(data, {
    format: "I420",
    codedWidth: HOUSE.width,
    codedHeight: HOUSE.height,
    timestamp: 0,
    duration: FRAME,
  })
}

/** The card's one frame, reshaped like everything else. */
const decodeStill = (card: string): Effect.Effect<VideoSample, ClipRejected> =>
  Effect.scoped(
    Effect.gen(function* () {
      const demuxer = yield* demuxed(card)
      const picture = yield* Option.match(Option.fromNullishOr(demuxer.video()), {
        onNone: () => refuse(card, "it holds no image"),
        onSome: Effect.succeed,
      })
      const decoder = yield* decoded(card, picture)
      const graph = yield* filtered(VIDEO_GRAPH)
      const first = yield* frames(card, graph.frames(decoder.frames(demuxer.packets()))).pipe(
        Stream.mapEffect(ownedVideo),
        Stream.runHead,
      )
      return yield* Option.match(first, {
        onNone: () => refuse(card, "it decoded to nothing"),
        onSome: Effect.succeed,
      })
    }),
  )

/**
 * Air the still for `seconds` from `offset`. Every frame is the same
 * frame, so the encoder only ever sees a clone with a new timestamp.
 */
const hold = (
  encoder: Encoder,
  still: VideoSample,
  offset: number,
  seconds: number,
): Effect.Effect<number, ClipRejected> =>
  Effect.gen(function* () {
    const frames = Math.round(HOUSE.frameRate * seconds)
    const seen = yield* Stream.fromIterable(Arr.range(0, frames - 1)).pipe(
      Stream.map((index) => {
        const at = still.clone()
        at.setTimestamp(offset + index * FRAME)
        at.setDuration(FRAME)
        return at
      }),
      Stream.mapEffect(played("the still", addVideo(encoder))),
      latest,
    )
    const heard = yield* silence(encoder, offset, seen)
    return Math.max(seen, heard) - offset
  })

// ---------------------------------------------------------------------------
// Broadcast: one response, held open
// ---------------------------------------------------------------------------

export type Broadcast = {
  /**
   * The stream from byte `from`: what is kept, then live. Any number of
   * viewers, any number of times, which is what a browser needs: it
   * drops a media connection whenever it likes and asks for the rest by
   * byte range later.
   */
  readonly tap: (from: number) => Stream.Stream<Uint8Array, ClipRejected>
  /** Air a clip after everything so far. Resolves with its length in seconds. */
  readonly append: (file: string) => Effect.Effect<number, ClipRejected>
  /** Air the still for `seconds` after everything so far. Black until `show`. */
  readonly hold: (seconds: number) => Effect.Effect<number, ClipRejected>
  /** Make `card` the still. Decoded once; showing the same card again is free. */
  readonly show: (card: string) => Effect.Effect<void, ClipRejected>
  readonly close: Effect.Effect<void>
}

/**
 * `StreamTarget` pushes into a `WritableStream`, so a writable/readable
 * pair is the smallest possible bridge out of mediabunny. It carries
 * chunks through untouched; everything done to them happens on the
 * Effect side.
 */
const bridge = (): TransformStream<StreamTargetChunk, StreamTargetChunk> => new TransformStream()

// ---------------------------------------------------------------------------
// What has been sent
//
// A browser treats a media URL as a file. It closes the connection when
// it has read far enough ahead and asks for the rest by byte range later,
// and its demuxer re-reads earlier bytes as it hops between tracks. So
// the broadcast keeps what it has written, bounded, and a viewer reads
// from wherever it needs to.
// ---------------------------------------------------------------------------

/** Bytes kept behind the live edge, so a returning viewer finds its place. */
const KEEP = 256 * 1024 * 1024

/** How long a viewer at the live edge waits before looking again. */
const POLL = "50 millis"

type Kept = {
  /** Absolute offset of the first byte still held. */
  readonly start: number
  /** Absolute offset just past the last byte written. */
  readonly end: number
  readonly chunks: ReadonlyArray<{ readonly at: number; readonly data: Uint8Array }>
  readonly closed: boolean
}

const NOTHING: Kept = { start: 0, end: 0, chunks: [], closed: false }

const keep = (kept: Kept, data: Uint8Array): Kept => {
  const end = kept.end + data.length
  const chunks = Arr.dropWhile(
    [...kept.chunks, { at: kept.end, data }],
    (chunk) => end - (chunk.at + chunk.data.length) > KEEP,
  )
  return {
    start: Option.match(Arr.head(chunks), { onNone: () => end, onSome: (first) => first.at }),
    end,
    chunks,
    closed: kept.closed,
  }
}

/** Everything held from `at` on, the first piece trimmed to start there. */
const since = (kept: Kept, at: number): ReadonlyArray<Uint8Array> =>
  kept.chunks.flatMap((chunk) => {
    if (chunk.at + chunk.data.length <= at) return []
    if (at <= chunk.at) return [chunk.data]
    return [chunk.data.subarray(at - chunk.at)]
  })

/** The next pieces after `at`, once there are any; `undefined` once the broadcast has closed. */
const readFrom = (
  kept: Ref.Ref<Kept>,
  at: number,
): Effect.Effect<readonly [ReadonlyArray<Uint8Array>, number] | undefined, ClipRejected> =>
  Effect.flatMap(Ref.get(kept), (now) => {
    if (at < now.start) {
      return refuse("the broadcast", `byte ${at} is no longer held`)
    }
    if (at < now.end) return Effect.succeed([since(now, at), now.end] as const)
    if (now.closed) return Effect.succeed(undefined)
    return Effect.andThen(Effect.sleep(POLL), readFrom(kept, at))
  })

/**
 * `fastStart: "fragmented"` is what makes this streamable: metadata rides
 * with each fragment instead of sitting in one table at the end, so the
 * response plays long before it is finished, and it need never finish.
 * Nothing is needed to open it: the house format is known up front.
 */
export const broadcast: Effect.Effect<Broadcast, ClipRejected> = Effect.gen(function* () {
  const { readable, writable } = bridge()
  const kept = yield* Ref.make(NOTHING)
  yield* Effect.forkChild(
    Stream.fromReadableStream({
      evaluate: () => readable,
      onError: rejected("the broadcast"),
    }).pipe(
      Stream.runForEach((chunk) => Ref.update(kept, (now) => keep(now, chunk.data))),
      Effect.ensuring(Ref.update(kept, (now) => ({ ...now, closed: true }))),
      Effect.ignore,
    ),
  )
  const output = new Output({
    // Short fragments: a fragment leaves only once every track has
    // crossed its end, and the viewer is waiting on it.
    format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 0.5 }),
    target: new StreamTarget(writable),
  })
  // Realtime keeps the encoder from sitting on seconds of lookahead,
  // which would otherwise eat the whole lead the timeline keeps. It
  // costs B-frames, which the bitrate buys back on a local wire.
  const encoder: Encoder = {
    video: new VideoSampleSource({ codec: "avc", bitrate: 8_000_000, latencyMode: "realtime" }),
    audio: new AudioSampleSource({ codec: "aac", bitrate: 128_000 }),
  }
  output.addVideoTrack(encoder.video, { frameRate: HOUSE.frameRate })
  output.addAudioTrack(encoder.audio)
  yield* Effect.tryPromise({ try: () => output.start(), catch: rejected("the broadcast") })

  const offset = yield* Ref.make(0)
  const still = yield* Ref.make<Still>({ card: Option.none(), picture: blank() })

  /** Run `air` from the current end of the timeline and move it on. */
  const after = (air: (at: number) => Effect.Effect<number, ClipRejected>) =>
    Effect.flatMap(Ref.get(offset), (at) =>
      Effect.tap(air(at), (length) => Ref.set(offset, at + length)),
    )

  return {
    tap: (from) =>
      Stream.unfold(from, (at) => readFrom(kept, at)).pipe(
        Stream.flatMap((pieces) => Stream.fromIterable(pieces)),
      ),
    append: (file) => after((at) => conform(encoder, file, at)),
    hold: (seconds) =>
      Effect.flatMap(Ref.get(still), (current) =>
        after((at) => hold(encoder, current.picture, at, seconds)),
      ),
    show: (card) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(still)
        if (Option.contains(current.card, card)) return
        const picture = yield* decodeStill(card)
        yield* Ref.set(still, { card: Option.some(card), picture })
        current.picture.close()
      }),
    // A closed broadcast is a viewer leaving, not a file to finish, so
    // the output is cancelled rather than finalized. Closing `writable`
    // directly would throw: `StreamTarget` holds a writer on it.
    close: Effect.all(
      [
        closing(() => output.cancel()),
        Ref.update(kept, (now) => ({ ...now, closed: true })),
        Effect.flatMap(Ref.get(still), (current) => Effect.sync(() => current.picture.close())),
      ],
      { discard: true },
    ),
  }
})

// ---------------------------------------------------------------------------
// Assemble: the whole programme, on disk
//
// Packets copied as they came from the provider, timestamps shifted,
// nothing decoded. A file can carry more than one codec configuration,
// so unlike the broadcast this keeps the original quality.
// ---------------------------------------------------------------------------

const opened = (file: string): Effect.Effect<Input, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) })),
    (input) => Effect.sync(() => input.dispose()),
  )

type Track = InputVideoTrack | InputAudioTrack

/** Both tracks are optional: a clip without audio is still a clip. */
type Tracks = {
  readonly video: Option.Option<EncodedVideoPacketSource>
  readonly audio: Option.Option<EncodedAudioPacketSource>
}

const shifted = (packet: EncodedPacket, offset: number): EncodedPacket =>
  new EncodedPacket(packet.data, packet.type, packet.timestamp + offset, packet.duration)

/**
 * Drain a track's packets through `add`, and report where it ended.
 * `add` is already bound to its sink, which is what keeps video and
 * audio metadata from having to share a type.
 */
const drain = (
  file: string,
  track: Track,
  offset: number,
  add: (packet: EncodedPacket) => Promise<void>,
) =>
  Stream.fromAsyncIterable(new EncodedPacketSink(track).packets(), rejected(file)).pipe(
    Stream.mapEffect((packet) =>
      Effect.as(
        Effect.tryPromise({ try: () => add(shifted(packet, offset)), catch: rejected(file) }),
        packet.timestamp + packet.duration,
      ),
    ),
    latest,
  )

/**
 * The decoder config is the same for every packet in a track, so it is
 * read once and carried. It is how a later clip can declare settings
 * that differ from the first one's.
 */
const pumpVideo = (
  file: string,
  track: InputVideoTrack,
  sink: EncodedVideoPacketSource,
  offset: number,
) =>
  Effect.gen(function* () {
    const config = yield* Effect.promise(() => track.getDecoderConfig())
    const meta = config === null ? {} : { decoderConfig: config }
    return yield* drain(file, track, offset, (packet) => sink.add(packet, meta))
  })

const pumpAudio = (
  file: string,
  track: InputAudioTrack,
  sink: EncodedAudioPacketSource,
  offset: number,
) =>
  Effect.gen(function* () {
    const config = yield* Effect.promise(() => track.getDecoderConfig())
    const meta = config === null ? {} : { decoderConfig: config }
    return yield* drain(file, track, offset, (packet) => sink.add(packet, meta))
  })

/** A track only moves if the clip has one and the output wants one. */
const paired = <T, S>(
  track: T | null,
  sink: Option.Option<S>,
  pump: (track: T, sink: S) => Effect.Effect<number, ClipRejected>,
) =>
  Option.match(Option.zipWith(Option.fromNullishOr(track), sink, pump), {
    onNone: () => Effect.succeed(0),
    onSome: (running) => running,
  })

/** Append a whole clip, and report how far the timeline advanced. */
const copy = (tracks: Tracks, file: string, offset: number): Effect.Effect<number, ClipRejected> =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* opened(file)
      const video = yield* Effect.promise(() => input.getPrimaryVideoTrack())
      const audio = yield* Effect.promise(() => input.getPrimaryAudioTrack())
      const ends = yield* Effect.all([
        paired(video, tracks.video, (t, s) => pumpVideo(file, t, s, offset)),
        paired(audio, tracks.audio, (t, s) => pumpAudio(file, t, s, offset)),
      ])
      return Math.max(...ends)
    }),
  )

/**
 * Declare the output's tracks from the first clip. A track states its
 * codec once, so a later clip that disagrees is rejected rather than
 * allowed to corrupt the file.
 */
const openWith = (output: Output, file: string): Effect.Effect<Tracks, ClipRejected> =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* opened(file)
      const video = yield* Effect.promise(() => input.getPrimaryVideoTrack())
      const audio = yield* Effect.promise(() => input.getPrimaryAudioTrack())
      const tracks: Tracks = {
        video: Option.map(Option.fromNullishOr(video), (track) => {
          const sink = new EncodedVideoPacketSource(track.codec ?? "avc")
          output.addVideoTrack(sink)
          return sink
        }),
        audio: Option.map(Option.fromNullishOr(audio), (track) => {
          const sink = new EncodedAudioPacketSource(track.codec ?? "aac")
          output.addAudioTrack(sink)
          return sink
        }),
      }
      yield* Effect.promise(() => output.start())
      return tracks
    }),
  )

const bytesOf = (target: BufferTarget): Uint8Array =>
  Option.match(Option.fromNullishOr(target.buffer), {
    onNone: () => new Uint8Array(),
    onSome: (buffer) => new Uint8Array(buffer),
  })

/**
 * Every clip in order as one ordinary MP4. Not fragmented, so it seeks
 * and scrubs like any other file.
 */
export const assemble = (files: ReadonlyArray<string>): Effect.Effect<Uint8Array, ClipRejected> =>
  Option.match(Arr.head(files), {
    onNone: () => Effect.succeed(new Uint8Array()),
    onSome: (first) =>
      Effect.gen(function* () {
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: "in-memory" }),
          target: new BufferTarget(),
        })
        const tracks = yield* openWith(output, first)
        const offset = yield* Ref.make(0)
        yield* Effect.forEach(
          files,
          (file) =>
            Effect.flatMap(Ref.get(offset), (at) =>
              Effect.tap(copy(tracks, file, at), (length) => Ref.set(offset, at + length)),
            ),
          { discard: true },
        )
        yield* Effect.promise(() => output.finalize())
        return bytesOf(output.target as BufferTarget)
      }),
  })
