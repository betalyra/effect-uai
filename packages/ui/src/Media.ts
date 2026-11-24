/**
 * Browser media as Effect streams: the microphone, a camera or screen, a
 * loudness meter, and a PCM player. Browser only, and not exported from the
 * package index. Each owns its devices and audio graph through the scope it
 * runs in, so interrupting a stream releases the microphone or camera.
 *
 * The audio runs in AudioWorklets the package ships as files
 * (`@effect-uai/ui/worklets/mic`, `…/player`); `micWorklet` / `playerWorklet`
 * point at them, or the app serves them itself and passes its own URL.
 * `mic` and `pcmPlayer` build the usual graph; for your own graph
 * (a device of your choice, an analyser, your own worklet) use the parts:
 * `loadWorklet`, `micNode` / `framesFrom`, `playerNode` / `playerFrom`.
 * Audio on the wire is 16-bit little-endian PCM, mono.
 */
import * as Pcm from "@effect-uai/core/Pcm"
import { Data, Effect, Queue, Ref, type Scope, Stream } from "effect"
import {
  MIC_PROCESSOR,
  type MicProcessorOptions,
  PLAYER_PROCESSOR,
  type PlayerCommand,
  type PlayerProcessorOptions,
  type PlayerReport,
} from "./internal/audio.js"

export class MediaError extends Data.TaggedError("MediaError")<{
  /** `denied`: the user or browser refused the device; `unavailable`: no device or no support. */
  readonly reason: "denied" | "unavailable"
  readonly message: string
}> {}

const failure = (error: unknown): MediaError => {
  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : String(error)
  return new MediaError({
    reason: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable",
    message,
  })
}

const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failure })

const stopTracks = (stream: MediaStream) =>
  Effect.sync(() => stream.getTracks().forEach((track) => track.stop()))

const audioContext = (options?: AudioContextOptions) =>
  Effect.acquireRelease(
    Effect.try({ try: () => new AudioContext(options), catch: failure }),
    (ctx) => Effect.promise(() => ctx.close().catch(() => undefined)),
  ).pipe(Effect.tap((ctx) => attempt(() => ctx.resume())))

// ---------------------------------------------------------------------------
// Worklets
// ---------------------------------------------------------------------------

// Bundlers (Vite, webpack, rspack, Parcel) copy a `new URL("./…", import.meta.url)`
// target into the build; unbundled, it resolves next to this module.
/** Where the shipped mic worklet is served; pass it to `mic` or `loadWorklet`. */
export const micWorklet: URL = new URL("./worklets/mic.mjs", import.meta.url)
/** Where the shipped player worklet is served; pass it to `pcmPlayer` or `loadWorklet`. */
export const playerWorklet: URL = new URL("./worklets/player.mjs", import.meta.url)

/** Load a worklet module (e.g. `micWorklet`) into a context. */
export const loadWorklet = (
  ctx: BaseAudioContext,
  url: string | URL,
): Effect.Effect<void, MediaError> => attempt(() => ctx.audioWorklet.addModule(url))

/** A mic worklet node (its module loaded) that posts 16-bit PCM frames at `sampleRate`. */
export const micNode = (
  ctx: BaseAudioContext,
  options: { readonly sampleRate: number; readonly frameMs?: number },
): AudioWorkletNode => {
  const processorOptions: MicProcessorOptions = {
    targetRate: options.sampleRate,
    frameMs: options.frameMs ?? 50,
  }
  return new AudioWorkletNode(ctx, MIC_PROCESSOR, { processorOptions })
}

/** The frames a mic worklet node posts; ending the stream detaches from the node. */
export const framesFrom = (node: AudioWorkletNode): Stream.Stream<Uint8Array> =>
  Stream.callback<Uint8Array>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        node.port.onmessage = (e: MessageEvent<ArrayBuffer>) =>
          Queue.offerUnsafe(queue, new Uint8Array(e.data))
      }),
      () => Effect.sync(() => (node.port.onmessage = null)),
    ),
  )

/** A player worklet node (its module loaded); connect it to an output. */
export const playerNode = (
  ctx: BaseAudioContext,
  options?: { readonly warmupMs?: number },
): AudioWorkletNode => {
  const processorOptions: PlayerProcessorOptions = { warmupMs: options?.warmupMs ?? 200 }
  return new AudioWorkletNode(ctx, PLAYER_PROCESSOR, { processorOptions })
}

// ---------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------

export type MicOptions = {
  /** The rate to send at, typically what the server declared on its `up` channel. */
  readonly sampleRate: number
  /** Where the app serves `@effect-uai/ui/worklets/mic`. */
  readonly worklet: string | URL
  /** Default 50. */
  readonly frameMs?: number
  /** Default true. */
  readonly echoCancellation?: boolean
  /** Default true. */
  readonly noiseSuppression?: boolean
  /** Default true. */
  readonly autoGainControl?: boolean
}

/**
 * The microphone as 16-bit PCM frames at `sampleRate`. Asks for the device
 * when the stream starts; ending the stream releases it.
 */
export const mic = (options: MicOptions): Stream.Stream<Uint8Array, MediaError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const stream = yield* Effect.acquireRelease(
        attempt(() =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: options.echoCancellation ?? true,
              noiseSuppression: options.noiseSuppression ?? true,
              autoGainControl: options.autoGainControl ?? true,
            },
          }),
        ),
        stopTracks,
      )
      // Chrome and Safari give a MediaStreamAudioSourceNode silence unless an
      // <audio> element also consumes the stream; a muted one is enough.
      const anchor = new Audio()
      anchor.srcObject = stream
      anchor.muted = true
      yield* Effect.addFinalizer(() => Effect.sync(() => (anchor.srcObject = null)))
      yield* Effect.promise(() => anchor.play().catch(() => undefined))

      // The device's own rate; the worklet resamples.
      const ctx = yield* audioContext()
      yield* loadWorklet(ctx, options.worklet)
      const node = micNode(ctx, options)
      ctx.createMediaStreamSource(stream).connect(node)
      // A silent sink keeps the graph pulling on the worklet.
      const sink = ctx.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(ctx.destination)
      return framesFrom(node)
    }),
  )

/** Loudness of each 16-bit PCM frame as RMS in [0, 1], for meters and gates. */
export const level = <E, R>(pcm: Stream.Stream<Uint8Array, E, R>): Stream.Stream<number, E, R> =>
  Stream.map(pcm, (bytes) => {
    const samples = Pcm.s16leToF32(bytes)
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2
    return Math.sqrt(sum / Math.max(1, samples.length))
  })

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export type CameraOptions = {
  readonly source: "camera" | "screen"
  /** Frames per second. Default 1. */
  readonly fps?: number
  /** Longest side of a frame in pixels. Default 768. */
  readonly maxSide?: number
  /** JPEG quality in [0, 1]. Default 0.7. */
  readonly quality?: number
  /** Shows the live picture here while the stream runs. */
  readonly preview?: HTMLVideoElement
}

const jpeg = (
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  options: CameraOptions,
): Effect.Effect<Uint8Array | undefined> =>
  Effect.gen(function* () {
    const { videoWidth: width, videoHeight: height } = video
    if (width === 0 || height === 0) return undefined
    const scale = Math.min(1, (options.maxSide ?? 768) / Math.max(width, height))
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = yield* Effect.promise(
      () =>
        new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", options.quality ?? 0.7),
        ),
    )
    return blob === null
      ? undefined
      : new Uint8Array(yield* Effect.promise(() => blob.arrayBuffer()))
  })

/** A camera or the screen as JPEG frames, `fps` a second; ending the stream releases the device. */
export const camera = (options: CameraOptions): Stream.Stream<Uint8Array, MediaError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const stream = yield* Effect.acquireRelease(
        attempt(() =>
          options.source === "screen"
            ? navigator.mediaDevices.getDisplayMedia({ video: true })
            : navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment", width: { ideal: 1280 } },
              }),
        ),
        stopTracks,
      )
      const video = options.preview ?? document.createElement("video")
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      yield* Effect.addFinalizer(() => Effect.sync(() => (video.srcObject = null)))
      yield* attempt(() => video.play())
      const canvas = document.createElement("canvas")
      return Stream.tick(`${Math.round(1000 / (options.fps ?? 1))} millis`).pipe(
        Stream.mapEffect(() => jpeg(video, canvas, options)),
        Stream.filter((frame): frame is Uint8Array => frame !== undefined),
      )
    }),
  )

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export type Player = {
  /** Queue 16-bit PCM; an odd trailing byte waits for the next chunk. */
  readonly push: (bytes: Uint8Array) => Effect.Effect<void>
  /** Drop everything queued (a stopped reply) and restart the count. */
  readonly clear: Effect.Effect<void>
  /** Restart the count without dropping anything (a new reply begins). */
  readonly reset: Effect.Effect<void>
  /** Milliseconds played since the last `clear` or `reset`. */
  readonly played: Effect.Effect<number>
}

const splitS16 = Pcm.splitSamples(2)

/** A `Player` driving a player worklet node, for the lifetime of the scope. */
export const playerFrom = (node: AudioWorkletNode): Effect.Effect<Player, never, Scope.Scope> =>
  Effect.gen(function* () {
    const played = yield* Ref.make(0)
    const carry = yield* Ref.make<Uint8Array>(new Uint8Array(0))
    const command = (message: PlayerCommand, transfer: Array<Transferable> = []) =>
      node.port.postMessage(message, transfer)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        node.port.onmessage = (e: MessageEvent<PlayerReport>) =>
          Effect.runSync(Ref.set(played, e.data.played))
      }),
      () => Effect.sync(() => (node.port.onmessage = null)),
    )

    const push = (bytes: Uint8Array) =>
      Effect.flatMap(
        Ref.modify(carry, (rest) => {
          const [next, whole] = splitS16(rest, bytes)
          return [whole, next] as const
        }),
        (whole) =>
          Effect.sync(() => {
            if (whole.byteLength === 0) return
            const samples = Pcm.s16leToF32(whole)
            command(samples, [samples.buffer])
          }),
      )

    const send = (type: "clear" | "reset") =>
      Effect.andThen(
        type === "clear" ? Ref.set(carry, new Uint8Array(0)) : Effect.void,
        Effect.andThen(
          Ref.set(played, 0),
          Effect.sync(() => command({ type })),
        ),
      )

    return { push, clear: send("clear"), reset: send("reset"), played: Ref.get(played) }
  })

export type PlayerOptions = {
  /** The rate of the audio pushed, typically from its `channel-opened`. */
  readonly sampleRate: number
  /** Where the app serves `@effect-uai/ui/worklets/player`. */
  readonly worklet: string | URL
  /** Default 200. */
  readonly warmupMs?: number
}

/**
 * A PCM player for the lifetime of the scope. Create it after a user gesture
 * (a click), or the browser keeps its audio suspended.
 */
export const pcmPlayer = (options: PlayerOptions): Effect.Effect<Player, MediaError, Scope.Scope> =>
  Effect.gen(function* () {
    const ctx = yield* audioContext({ sampleRate: options.sampleRate })
    yield* loadWorklet(ctx, options.worklet)
    const node = playerNode(ctx, options)
    node.connect(ctx.destination)
    return yield* playerFrom(node)
  })
